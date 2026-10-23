import { createHash } from "node:crypto";
import { ImDeliveryError, type ImAdapter, type ImAdapterSession, type ImAddress, type ImCapabilities, type ImCommand, type ImContextMessage, type ImDelivery, type ImInbound, type ImLink } from "@tomradex/plugin-sdk";
import { Gateway, net, type Net } from "./gateway.js";
import { projectChoices, setUp, setupCommand, setupOf } from "./setup.js";
import { actorOf, addressOf, API, installLink, INTENTS, inboundMessage, isThread, MESSAGE_CONTENT, messageOf, parseControl, REACTIONS, threadName, threadOf, wantsContent, type DInteraction, type DMessage, type DUser, type DOption, type Permission } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  maxTextLength: 2000, maxFileBytes: 10 * 1024 * 1024,
  // A reply quotes the message that asked; the bot opens a thread per ticket being worked (`topics`).
  threads: false, topics: true, reactions: true, typing: true, stream: "edit",
  select: true, multiSelect: true, textInput: true, cards: true, cardUpdate: true,
  nativeCommands: true, ephemeral: false, markdown: "discord",
  // About five messages or edits per channel every five seconds before Discord answers 429.
  rateLimit: { messages: 5, windowMs: 5_000 }
};

type IO = Parameters<ImAdapter["open"]>[1];

/** One REST call. A 429 is retryable after Discord's wait; other refusals are permanent. */
async function call(n: Net, token: string, method: string, path: string, body?: unknown, files?: { name: string; mimeType: string; bytes: Uint8Array }[]) {
  let init: RequestInit = { method, headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (Tomrade, 0.1.0)" } };
  if (files?.length) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ ...(body as object), attachments: files.map((f, i) => ({ id: i, filename: f.name })) }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.bytes)], { type: f.mimeType }), f.name));
    init = { ...init, body: form };
  } else if (body !== undefined) init = { ...init, headers: { ...init.headers as Record<string, string>, "content-type": "application/json" }, body: JSON.stringify(body) };
  let res: Response;
  try { res = await n.fetch(`${API}${path}`, init); }
  // Messages carry a nonce Discord enforces, edits and reactions are idempotent: a lost answer is safe to retry.
  catch (e) { throw new ImDeliveryError(`Discord unreachable: ${(e as Error).message}`, "retryable"); }
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({})) as { retry_after?: number }).retry_after ?? res.headers.get("retry-after") ?? 1);
    throw new ImDeliveryError("Discord rate limit", "retryable", Math.ceil(wait * 1000));
  }
  if (res.status >= 500) throw new ImDeliveryError(`Discord error ${res.status}`, "retryable");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({})) as { message?: string; code?: number };
    throw Object.assign(new ImDeliveryError(`Discord refused (${res.status}${detail.message ? `: ${detail.message}` : ""})`, "permanent"), { code: detail.code });
  }
  return res.status === 204 ? null : res.json() as Promise<Record<string, unknown>>;
}

/** Missing Access (the bot cannot see the channel) and Missing Permissions. */
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

/** What the bot could not do, by the permission it lacked, in the person's words. */
const UNABLE: Record<Permission, { en: string; zh: string }> = {
  "View Channels": { en: "see", zh: "查看" },
  "Send Messages": { en: "post", zh: "发消息" },
  "Send Messages in Threads": { en: "post in threads", zh: "在话题里发消息" },
  "Create Public Threads": { en: "open a thread per ticket", zh: "给工单开话题" },
  "Manage Threads": { en: "rename or archive ticket threads", zh: "改名或归档工单话题" },
  "Read Message History": { en: "read the history", zh: "读取历史消息" },
  "Embed Links": { en: "show cards", zh: "显示卡片" },
  "Attach Files": { en: "attach files", zh: "附加文件" },
  "Add Reactions": { en: "react to messages", zh: "给消息加表情" },
  "Manage Channels": { en: "create channels", zh: "创建频道" }
};

/** Remembers the most recent `max` entries. */
class Recent<V> extends Map<string, V> {
  constructor(private readonly max: number) { super(); }
  override set(key: string, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

/** The `/tomrade` command: one subcommand per IM command, with free text after it, and the adapter's own `extra`. */
function commandsOf(commands: ImCommand[], extra: Record<string, unknown>[] = []) {
  return [{
    name: "tomrade", type: 1, description: "Tomrade", contexts: [0, 1], integration_types: [0],
    options: [...commands.slice(0, 25 - extra.length).map(c => ({
      type: 1, name: c.name.toLowerCase().slice(0, 32), description: c.description.slice(0, 100) || c.name,
      ...(c.args ? { options: [{ type: 3, name: "args", description: c.args.slice(0, 100), required: false }] } : {})
    })), ...extra]
  }];
}

export async function openDiscord(connectionId: string, io: IO, opts: { net?: Net; backoffMs?: number } = {}): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const token = io.credentials.botToken?.trim() ?? "";
  if (!token) throw new Error("Discord bot token is missing");
  const rest = (method: string, path: string, body?: unknown, files?: Parameters<typeof call>[5]) => call(n, token, method, path, body, files);

  /** Thread → parent channel, learned from the gateway and asked for once otherwise. */
  const parents = new Map<string, string | null>();
  const attachments = new Recent<string>(500);
  /** Who sent a recent message, so a deletion or an edit can be told to the common layer as theirs. */
  const authors = new Recent<string>(1000);
  let botId = "";
  let applicationId = "";
  // Events reach the common layer one at a time, in Discord's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  /** Channel → its type, for opening the right kind of thread in it. */
  const kinds = new Map<string, number>();
  /** Channel → its name, for Settings to show instead of its id. */
  const channelNames = new Map<string, string>();
  const learnChannel = (c: { id: string; type: number; parent_id?: string | null; name?: string | null }) => {
    parents.set(c.id, isThread(c.type) ? c.parent_id ?? null : null);
    kinds.set(c.id, c.type);
    if (c.name) channelNames.set(c.id, c.name);
  };
  const parentOf = (id: string) => parents.get(id) ?? null;
  /** A thread's first message, read once per thread. */
  const roots = new Recent<ImContextMessage | null>(200);
  const rootOf = async (threadId: string, parentId: string): Promise<ImContextMessage | null> => {
    if (roots.has(threadId)) return roots.get(threadId)!;
    let root: ImContextMessage | null = null;
    // A thread opened from a message shares its id, in the parent channel; a forum post's starter is inside the thread.
    for (const channel of [parentId, threadId]) {
      const m = await rest("GET", `/channels/${channel}/messages/${threadId}`).catch(() => null) as DMessage | null;
      if (m?.author && m.content?.trim()) { root = { role: "root", messageId: m.id, author: actorOf(m.author), text: m.content }; break; }
      if (m) break;
    }
    roots.set(threadId, root);
    return root;
  };
  const ensureChannel = async (guildId: string | undefined, channelId: string | undefined) => {
    if (!guildId || !channelId || parents.has(channelId)) return;
    try { learnChannel(await rest("GET", `/channels/${channelId}`) as { id: string; type: number; parent_id?: string | null }); }
    catch { parents.set(channelId, null); }
  };

  /** Within Discord's three seconds, before anything slower happens. */
  const answer = (i: DInteraction, body: unknown) => rest("POST", `/interactions/${i.id}/${i.token}/callback`, body).catch(() => null);

  const onInteraction = (i: DInteraction) => {
    const user = i.member?.user ?? i.user;
    if (!user || !i.channel_id) return;
    if (i.type === 4 && setupOf(i)) { void answer(i, { type: 8, data: { choices: projectChoices(io, i, user.id) } }); return; }
    if (i.type === 2 && setupOf(i)) {
      // Only the person who ran it sees how it went.
      void answer(i, { type: 5, data: { flags: 64 } }).then(() => later(async () => {
        const said = await setUp(io, rest, i, user.id, installLink(applicationId), learnChannel);
        await rest("PATCH", `/webhooks/${applicationId}/${i.token}/messages/@original`, { content: said, allowed_mentions: { parse: [] } }).catch(() => null);
      }));
      return;
    }
    if (i.type === 2 && i.data?.name === "tomrade") {
      void answer(i, { type: 5 }).then(() => later(async () => {
        await ensureChannel(i.guild_id, i.channel_id);
        const sub = i.data?.options?.[0];
        const args = sub?.options?.find((o: DOption) => o.name === "args")?.value?.trim();
        const text = sub ? `/${sub.name}${args ? ` ${args}` : ""}` : "/help";
        // The deferred reply becomes the visible command, and the message replies quote and react to.
        const original = await rest("PATCH", `/webhooks/${applicationId}/${i.token}/messages/@original`, { content: `› ${text}`, allowed_mentions: { parse: [] } }).catch(() => null);
        await receive({ kind: "message", eventId: `i:${i.id}`, messageId: (original?.id as string | undefined) ?? i.id, text, activation: i.guild_id ? "mention" : "dm",
          actor: actorOf(user), address: addressOf(i.guild_id, i.channel_id!, parentOf) });
      }));
      return;
    }
    const control = parseControl(i.data?.custom_id);
    if (!control) return;
    if (i.type === 3 && control.kind === "i") {
      void answer(i, { type: 9, data: { custom_id: i.data!.custom_id, title: "Tomrade",
        components: [{ type: 1, components: [{ type: 4, custom_id: "answer", style: 2, label: "Answer", required: true, max_length: 4000 }] }] } });
      return;
    }
    const value = i.type === 5 ? i.data?.components?.[0]?.components?.[0]?.value
      : control.kind === "m" ? i.data?.values : control.kind === "s" ? i.data?.values?.[0] : undefined;
    void answer(i, { type: 6 }).then(() => later(async () => {
      await ensureChannel(i.guild_id, i.channel_id);
      await receive({ kind: "action", eventId: `i:${i.id}`, token: control.token, ...(value !== undefined ? { value } : {}), actor: actorOf(user), address: addressOf(i.guild_id, i.channel_id!, parentOf) });
    }));
  };

  const dispatch = (type: string, data: unknown) => {
    switch (type) {
      case "GUILD_CREATE": {
        const g = data as { channels?: { id: string; type: number; parent_id?: string | null }[]; threads?: { id: string; type: number; parent_id?: string | null }[] };
        for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) learnChannel(c);
        return;
      }
      case "THREAD_CREATE": case "THREAD_UPDATE": case "CHANNEL_CREATE":
        learnChannel(data as { id: string; type: number; parent_id?: string | null });
        return;
      case "THREAD_LIST_SYNC":
        for (const t of (data as { threads?: { id: string; type: number; parent_id?: string | null }[] }).threads ?? []) learnChannel(t);
        return;
      case "MESSAGE_CREATE": {
        const m = data as DMessage;
        later(async () => {
          await ensureChannel(m.guild_id, m.channel_id);
          const found = inboundMessage(m, botId, parentOf);
          if (!found) return;
          let event = found;
          const topic = event.address.topicId;
          if (topic && event.activation !== "ambient" && topic !== event.replyTo) {
            const root = await rootOf(topic, event.address.conversationId);
            if (root) event = { ...event, context: [...(event.context ?? []), root] };
          }
          authors.set(m.id, m.author.id);
          for (const a of m.attachments ?? []) attachments.set(a.id, a.url);
          await receive(event);
        });
        return;
      }
      case "MESSAGE_UPDATE": {
        const m = data as Partial<DMessage> & { id: string; channel_id: string };
        const author = authors.get(m.id);
        if (!author || !m.edited_timestamp) return;
        later(() => receive({ kind: "edit", eventId: `e:${m.id}:${m.edited_timestamp}`, messageId: m.id, actor: { id: author, isBot: false }, address: addressOf(m.guild_id, m.channel_id, parentOf) }));
        return;
      }
      case "MESSAGE_DELETE": {
        const m = data as { id: string; channel_id: string; guild_id?: string };
        const author = authors.get(m.id);
        if (!author) return;
        later(() => receive({ kind: "retract", eventId: `d:${m.id}`, messageId: m.id, actor: { id: author, isBot: false }, address: addressOf(m.guild_id, m.channel_id, parentOf) }));
        return;
      }
      case "INTERACTION_CREATE":
        onInteraction(data as DInteraction);
        return;
    }
  };

  const gateway = new Gateway(token, n, {
    dispatch,
    state: (state, detail) => io.status(state === "connected" ? "connected" : state === "connecting" ? "connecting" : "error", detail)
  }, { ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), intents: wantsContent(io.credentials.messageContent) ? INTENTS | MESSAGE_CONTENT : INTENTS });
  io.signal.addEventListener("abort", () => gateway.stop(), { once: true });
  const ready = await gateway.start();
  botId = ready.user.id;
  applicationId = ready.applicationId;

  const channelOf = (address: ImAddress, threadId?: string) => threadId ?? address.topicId ?? address.conversationId;
  const addBot = { en: "Add the bot to a server", zh: "把机器人加到服务器" };
  const install: ImLink = { label: addBot, url: installLink(applicationId) };

  /** Channel and permission pairs told to the person, so each is said once until it works again. */
  const missing = new Set<string>();
  /**
   * Runs a call in a server channel, saying once per channel and permission when Discord refuses it for one the bot
   * lacks; the refusal still reaches the IM layer, which keeps the news in the channel's main conversation.
   */
  const guarded = async <T>(address: ImAddress, permission: Permission, work: () => Promise<T>): Promise<T> => {
    const key = `perm:${address.conversationId}:${permission}`;
    try {
      const done = await work();
      if (missing.delete(key)) io.clearNotice?.(key);
      return done;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (address.tenantId !== "@me" && (code === MISSING_PERMISSIONS || code === MISSING_ACCESS) && !missing.has(key)) {
        missing.add(key);
        const lacked: Permission = code === MISSING_ACCESS ? "View Channels" : permission;
        const where = { tenantId: address.tenantId, conversationId: address.conversationId };
        const text = {
          en: `I can't ${UNABLE[lacked].en} in <#${where.conversationId}>: the bot is missing the **${lacked}** permission. Add the bot again with the link below to grant it, or allow it in the channel's settings.`,
          zh: `我在 <#${where.conversationId}> 里无法${UNABLE[lacked].zh}：机器人缺少 **${lacked}** 权限。用下面的链接重新添加机器人即可授予，或者在频道设置里允许它。`
        };
        if (io.notice) io.notice({ key, text, address: where, link: install });
        // An older Tomrade has no notices: the channel hears it from the bot directly, if it can.
        else void rest("POST", `/channels/${where.conversationId}/messages`, { content: `${text.en}\n${addBot.en}: ${install.url}`, allowed_mentions: { parse: [] } }).catch(() => null);
      }
      throw e;
    }
  };
  let reacted = new Recent<string>(500);
  /** The name each thread was last given; Discord allows only a couple of renames per thread every ten minutes. */
  const named = new Recent<string>(500);

  return {
    identity: { id: ready.user.id, name: ready.user.username },
    links: [install],

    /** A server channel as `#name`; a direct chat by the person in it. */
    async describe(address) {
      const id = address.conversationId;
      if (address.tenantId === "@me") {
        const dm = await rest("GET", `/channels/${id}`).catch(() => null) as { recipients?: DUser[] } | null;
        const who = dm?.recipients?.[0];
        return who ? { name: who.global_name || who.username } : null;
      }
      if (!channelNames.has(id)) {
        const c = await rest("GET", `/channels/${id}`).catch(() => null) as { id: string; type: number; parent_id?: string | null; name?: string } | null;
        if (c) learnChannel(c);
      }
      const name = channelNames.get(id);
      return name ? { name: `#${name}` } : null;
    },

    deliver: (d: ImDelivery) => guarded(d.address, d.content.files?.length ? "Attach Files" : d.address.topicId || d.threadId ? "Send Messages in Threads" : "Send Messages", async () => {
      const channel = channelOf(d.address, d.threadId);
      const payload = messageOf(d.content);
      if (d.replaceMessageId) {
        const res = await rest("PATCH", `/channels/${channel}/messages/${d.replaceMessageId}`, payload);
        return { messageId: (res?.id as string | undefined) ?? d.replaceMessageId };
      }
      const files = [];
      for (const f of d.content.files ?? []) files.push({ name: f.name, mimeType: f.mimeType, bytes: await io.readOutboundFile(f.id) });
      // Discord drops a second message with the same nonce, so a retry after a lost answer never posts twice.
      const nonce = createHash("sha256").update(d.operationId).digest("base64url").slice(0, 25);
      const res = await rest("POST", `/channels/${channel}/messages`, {
        ...payload, nonce, enforce_nonce: true,
        ...(d.replyTo ? { message_reference: { message_id: d.replyTo, fail_if_not_exists: false } } : {})
      }, files);
      return { messageId: res!.id as string };
    }),

    async download(ref) {
      const url = attachments.get(ref.id);
      if (!url) throw new Error("Attachment is no longer known");
      const res = await n.fetch(url);
      if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },

    async indicate({ address, threadId, state }) {
      if (state !== "idle") await rest("POST", `/channels/${channelOf(address, threadId)}/typing`);
    },

    react: ({ address, messageId, reaction }) => guarded(address, "Add Reactions", async () => {
      const channel = channelOf(address);
      const previous = reacted.get(messageId);
      if (previous && previous !== REACTIONS[reaction]) await rest("DELETE", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent(previous)}/@me`).catch(() => null);
      await rest("PUT", `/channels/${channel}/messages/${messageId}/reactions/${encodeURIComponent(REACTIONS[reaction])}/@me`);
      reacted.set(messageId, REACTIONS[reaction]);
    }),

    topics: {
      async open({ address, title }) {
        const channel = address.conversationId;
        if (address.tenantId === "@me") throw new ImDeliveryError("Direct messages have no threads", "permanent");
        if (!kinds.has(channel)) learnChannel(await rest("GET", `/channels/${channel}`) as { id: string; type: number; parent_id?: string | null });
        const kind = kinds.get(channel) ?? 0;
        // A forum or media channel takes a post, which is a message.
        const res = await guarded(address, [15, 16].includes(kind) ? "Send Messages" : "Create Public Threads",
          () => rest("POST", `/channels/${channel}/threads`, threadOf(kind, title))) as { id: string; type?: number };
        // Messages in it arrive as its topic before the gateway says it exists.
        learnChannel({ id: res.id, type: res.type ?? 11, parent_id: channel });
        named.set(res.id, threadName(title));
        return { topicId: res.id };
      },

      async update({ address, title, closed }) {
        const name = threadName(title);
        // Reopening and renaming go in one edit; an archived thread takes no other change.
        await guarded(address, "Manage Threads", () => rest("PATCH", `/channels/${address.topicId}`, { ...(named.get(address.topicId) !== name ? { name } : {}), archived: closed }));
        named.set(address.topicId, name);
      }
    },

    async commands(list) {
      await rest("PUT", `/applications/${applicationId}/commands`, commandsOf(list, setupCommand(io)));
    },

    close() {
      gateway.stop();
      reacted = new Recent(0);
    }
  };
}
