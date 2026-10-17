import type { ImAdapter, ImAdapterSession, ImCapabilities, ImContent, ImContextMessage, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { Api, net, SlackError, type Net } from "./api.js";
import { controlOf, markdownOf, messageOf } from "./blocks.js";
import { type Envelope, SocketMode } from "./gateway.js";
import { addressOf, commandText, isDirect, mentions, messageId, REACTIONS, textOf, threadOf, tsOf, usersIn,
  type SBlockActions, type SCommand, type SEventCallback, type SFile, type SMessage, type SStopped } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  // One mrkdwn section holds 3000 characters; a longer reply goes as several messages.
  maxTextLength: 3000,
  // Under the IM layer's own 32 MB, so a larger file is refused by name.
  maxFileBytes: 30 * 1024 * 1024,
  // A channel is one conversation and each answer goes into the asking message's thread; "thinking" is the assistant status.
  threads: true, reactions: true, typing: true, stream: "native",
  select: true, multiSelect: true, textInput: true, cards: true, cardUpdate: true,
  // `/tomrade` lives in the app manifest; Slack takes no commands from a bot token at runtime.
  nativeCommands: false,
  // An ephemeral message can be replaced only through its interaction's response URL, which later updates never have.
  ephemeral: false, markdown: "slack",
  // About a message a second in one channel, with short bursts.
  rateLimit: { messages: 3, windowMs: 3000 }
};

type IO = Parameters<ImAdapter["open"]>[1];

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

/** The IM layer refuses a declared size above this, so a larger file is named at its cap and refused as too large. */
const INBOUND_CAP = 32 * 1024 * 1024;
/** Slack allows 40,000 characters; the IM layer takes 32,000. */
const TEXT_CAP = 32_000;
/** Message subtypes that are a person's message; joins, bots and the rest are not. */
const PERSONAL = new Set([undefined, "file_share", "thread_broadcast"]);
const THINKING = { en: "is thinking…", zh: "正在思考…" };

export interface SlackOptions { net?: Net; backoffMs?: number; idleMs?: number }

export async function openSlack(connectionId: string, io: IO, opts: SlackOptions = {}): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const appToken = io.credentials.appToken?.trim() ?? "";
  const botToken = io.credentials.botToken?.trim() ?? "";
  if (!appToken || !botToken) throw new Error("The App-Level Token and the Bot Token are both needed");
  if (!appToken.startsWith("xapp-")) throw new Error("The App-Level Token starts with xapp- (Basic Information → App-Level Tokens)");
  if (!botToken.startsWith("xoxb-")) throw new Error("The Bot Token starts with xoxb- (Install App → Bot User OAuth Token)");
  let socket: SocketMode | null = null;
  const api = new Api(botToken, n, code => { if (socket) io.status("error", `Slack no longer takes the Bot Token (${code})`); });

  // Who the bot token signs in as; a wrong token fails here, in Slack's words.
  const auth = await api.call<{ team_id: string; user_id: string; user?: string; bot_id?: string }>("auth.test", {}, { repeatable: true }).catch((e: unknown) => {
    throw new Error(`Slack refused the Bot Token (${e instanceof SlackError ? e.code ?? e.message : String(e)})`);
  });
  const team = auth.team_id;
  const botUserId = auth.user_id;
  const botId = auth.bot_id ?? "";

  const names = new Recent<string | null>(500);
  let namesAllowed = true;
  /** File URLs from the messages that carried them, so a download needs no lookup. */
  const files = new Recent<{ url: string; mimeType?: string }>(500);
  /** Channel threads: whether the bot is in them, and their first message. */
  const threads = new Recent<{ ours: boolean; root: ImContextMessage | null }>(500);
  /** Who last wrote in a thread, the person a stream in it is for. */
  const people = new Recent<string>(1000);
  /** The thread a person last wrote in, per direct message channel, which `/tomrade` there acts on. */
  const lastThread = new Recent<string>(500);
  /** A language per channel, from what people wrote, for the "thinking" status. */
  const chinese = new Recent<boolean>(500);
  const reacted = new Recent<string>(500);
  /** Selects whose long values went by place, by token. */
  const choices = new Recent<string[]>(200);
  /** Parts of a delivery already sent, so a retry after a later part failed does not post them again. */
  const done = new Recent<string>(1000);
  const events = new Recent<true>(2000);
  /** Channels where Slack shows no assistant status; asked once. */
  const statusless = new Recent<true>(200);
  let legacyStatus = true;
  const streams = new Map<string, { channel: string; text: string; sent: string; native: boolean }>();

  // Events reach the IM layer one at a time, in Slack's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  const nameOf = async (id: string): Promise<string | undefined> => {
    if (names.has(id) || !namesAllowed) return names.get(id) ?? undefined;
    let name: string | null = null;
    try {
      const r = await api.call<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: id }, { repeatable: true });
      name = r.user?.profile?.display_name || r.user?.real_name || r.user?.profile?.real_name || r.user?.name || null;
    } catch (e) {
      // Without users:read nobody's name can be read; stop asking.
      if (e instanceof SlackError && e.code === "missing_scope") namesAllowed = false;
    }
    names.set(id, name);
    return name ?? undefined;
  };

  const read = async (text: string) => {
    for (const id of usersIn(text)) if (id !== botUserId) await nameOf(id);
    return textOf(text, botUserId, id => names.get(id) ?? undefined);
  };

  /** A channel thread: whether the bot has written in it, and its first message. Needs the history scopes; without them it is unknown. */
  const thread = async (channel: string, root: string) => {
    const key = `${channel}:${root}`;
    const known = threads.get(key);
    if (known) return known;
    const found: { ours: boolean; root: ImContextMessage | null } = { ours: false, root: null };
    try {
      const r = await api.call<{ messages?: SMessage[] }>("conversations.replies", { channel, ts: root, limit: 200 }, { repeatable: true });
      const messages = r.messages ?? [];
      found.ours = messages.some(m => m.user === botUserId || (!!botId && m.bot_id === botId));
      const first = messages[0];
      if (first?.ts === root && first.text?.trim()) {
        const isBot = !!first.bot_id;
        const author = first.user ?? first.bot_id ?? "";
        const name = isBot ? undefined : author ? await nameOf(author) : undefined;
        found.root = { role: "root", messageId: messageId(root), author: { id: author || "unknown", ...(name ? { name } : {}), isBot }, text: (await read(first.text)).slice(0, TEXT_CAP) };
      }
    } catch (e) {
      // Without the history scopes it stays unknown, and only an @mention wakes the bot there; a passing failure is asked again.
      if (!(e instanceof SlackError) || e.disposition !== "permanent") return found;
    }
    threads.set(key, found);
    return found;
  };
  const joined = (channel: string, root: string) => {
    const key = `${channel}:${root}`;
    threads.set(key, { root: threads.get(key)?.root ?? null, ours: true });
  };

  const attachmentsOf = async (list: SFile[]) => {
    const out: NonNullable<(ImInbound & { kind: "message" })["attachments"]> = [];
    for (const [i, given] of list.slice(0, 8).entries()) {
      let f = given;
      // A file from another organization, or one the event cut short, is read in full first.
      if (f.file_access === "check_file_info" || !f.size) f = (await api.call<{ file?: SFile }>("files.info", { file: f.id }, { repeatable: true }).catch(() => null))?.file ?? f;
      const url = f.url_private_download ?? f.url_private;
      if (!url || !f.size || f.mode === "tombstone" || f.mode === "hidden_by_limit") continue;
      files.set(f.id, { url, ...(f.mimetype ? { mimeType: f.mimetype } : {}) });
      out.push({ id: f.id, name: (f.name || f.title || `file-${i + 1}`).slice(0, 255), mimeType: (f.mimetype || "application/octet-stream").slice(0, 128), size: Math.min(f.size, INBOUND_CAP) });
    }
    return out;
  };

  const onMessage = async (eventId: string, ev: SMessage) => {
    const channel = ev.channel;
    const user = ev.user;
    if (!channel || !user || ev.bot_id || user === botUserId || !PERSONAL.has(ev.subtype)) return;
    const direct = isDirect(channel);
    const raw = ev.text ?? "";
    const mentioned = ev.type === "app_mention" || mentions(raw, botUserId);
    // In a channel a mention also arrives as app_mention; that one is answered.
    if (!direct && ev.type !== "app_mention" && mentioned) return;
    const inThread = !!ev.thread_ts && ev.thread_ts !== ev.ts;
    const info = !direct && inThread ? await thread(channel, ev.thread_ts!) : null;
    const activation = direct ? "dm" : mentioned ? "mention" : info?.ours ? "reply" : "ambient";
    const text = (await read(raw)).slice(0, TEXT_CAP);
    const attachments = activation === "ambient" ? [] : await attachmentsOf(ev.files ?? []);
    if (!text && !attachments.length) return;
    const root = inThread ? ev.thread_ts! : ev.ts;
    if (activation !== "ambient") people.set(`${channel}:${root}`, user);
    if (direct) lastThread.set(channel, root);
    if (text) chinese.set(channel, /[\u3400-\u9fff]/.test(text));
    const name = await nameOf(user);
    await receive({
      kind: "message", eventId, messageId: messageId(ev.ts, ev.thread_ts), text, activation,
      actor: { id: user, ...(name ? { name } : {}), isBot: false }, address: addressOf(team, channel, ev.ts, ev.thread_ts),
      ...(attachments.length ? { attachments } : {}),
      ...(info?.root && activation !== "ambient" ? { context: [info.root] } : {})
    });
  };

  /** A person withdrew or edited a message they sent. */
  const amend = async (eventId: string, ev: SMessage) => {
    const deleted = ev.subtype === "message_deleted";
    const m = deleted ? ev.previous_message : ev.message;
    // A changed message without `edited` is Slack updating it (a reply count, an unfurl), not the person.
    if (!m?.user || m.bot_id || m.user === botUserId || (!deleted && !m.edited)) return;
    await receive({ kind: deleted ? "retract" : "edit", eventId, messageId: messageId(m.ts, m.thread_ts),
      actor: { id: m.user, isBot: false }, address: addressOf(team, ev.channel, m.ts, m.thread_ts) });
  };

  const onEvent = (cb: SEventCallback) => {
    if (events.has(cb.event_id)) return;
    events.set(cb.event_id, true);
    const ev = cb.event;
    if (ev.type === "message" || ev.type === "app_mention") {
      const m = ev as unknown as SMessage;
      later(() => m.subtype === "message_deleted" || m.subtype === "message_changed" ? amend(cb.event_id, m) : onMessage(cb.event_id, m));
    } else if (ev.type === "agent_session_stopped") {
      // The stop button under a reply in progress: the same as /stop in that thread.
      const s = ev as unknown as SStopped;
      for (const ts of s.streaming_message_ts ?? []) { const open = streams.get(ts); if (open) open.native = false; }
      if (!s.user || !s.channel) return;
      const user = s.user, channel = s.channel;
      later(() => receive({ kind: "message", eventId: cb.event_id, messageId: messageId(`stop:${s.event_ts ?? cb.event_id}`, s.thread_ts), text: "/stop",
        activation: isDirect(channel) ? "dm" : "mention", actor: { id: user, isBot: false }, address: addressOf(team, channel, undefined, s.thread_ts) }));
    }
  };

  /** Acknowledged at once, inside Slack's three seconds; the outcome updates the message later. */
  const onAction = (p: SBlockActions) => {
    const user = p.user?.id;
    const channel = p.channel?.id ?? p.container?.channel_id;
    const action = p.actions?.[0];
    if (!user || !channel || !action || !p.trigger_id) return;
    const control = controlOf(action, p.state?.values, token => choices.get(token));
    if (!control) return;
    const thread = p.message?.thread_ts ?? p.container?.thread_ts;
    const ts = p.message?.ts ?? p.container?.message_ts;
    later(() => receive({ kind: "action", eventId: `a:${p.trigger_id}`, token: control.token,
      ...(control.value !== undefined ? { value: control.value } : {}), actor: { id: user, isBot: false }, address: addressOf(team, channel, undefined, thread !== ts ? thread : undefined) }));
  };

  /**
   * `/tomrade <command>` runs that command, since Slack takes any message
   * that starts with `/` as a command of its own. In a direct message it acts
   * on the thread the person last wrote in.
   */
  const onCommand = (c: SCommand): unknown => {
    if (!c.user_id || !c.channel_id || !c.trigger_id) return undefined;
    const user = c.user_id, channel = c.channel_id;
    const direct = isDirect(channel);
    const text = commandText(c.text ?? "");
    const topic = direct ? lastThread.get(channel) : undefined;
    later(async () => {
      const name = await nameOf(user);
      await receive({ kind: "message", eventId: `c:${c.trigger_id}`, messageId: `cmd:${c.trigger_id}`, text, activation: direct ? "dm" : "mention",
        actor: { id: user, ...(name ? { name } : {}), isBot: false }, address: { tenantId: team, conversationId: channel, ...(topic ? { topicId: topic } : {}) } });
    });
    return { text: `› ${c.command ?? "/tomrade"} ${c.text ?? ""}`.trim() };
  };

  const onEnvelope = (env: Envelope): unknown => {
    const p = env.payload as Record<string, unknown> | undefined;
    if (!p) return undefined;
    if (env.type === "events_api" && p.type === "event_callback" && p.event) onEvent(p as unknown as SEventCallback);
    else if (env.type === "interactive" && p.type === "block_actions") onAction(p as unknown as SBlockActions);
    else if (env.type === "slash_commands") return onCommand(p as SCommand);
    return undefined;
  };

  socket = new SocketMode(new Api(appToken, n), n, {
    envelope: onEnvelope,
    state: (state, detail) => io.status(state, detail)
  }, { ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}) });
  const gateway = socket;
  io.signal.addEventListener("abort", () => gateway.stop(), { once: true });
  await gateway.start();

  const render = (content: ImContent) => {
    const m = messageOf(content);
    for (const [token, values] of m.choices) choices.set(token, values);
    return m;
  };

  /** Posts the message part of a delivery once: into the thread, or at the top of the channel. */
  const post = async (d: ImDelivery, channel: string, root: string | undefined): Promise<string> => {
    const key = `${d.operationId}:m`;
    const sent = done.get(key);
    if (sent) return sent;
    const { text, blocks } = render(d.content);
    const r = await api.call<{ ts: string }>("chat.postMessage", { channel, text, ...(blocks.length ? { blocks } : {}), ...(root ? { thread_ts: root } : {}) });
    done.set(key, r.ts);
    joined(channel, root ?? r.ts);
    return r.ts;
  };

  /** Uploads a delivery's files and shares them in one message, with the text as its comment when nothing else carried it. */
  const share = async (d: ImDelivery, channel: string, root: string | undefined, comment?: string): Promise<string> => {
    const key = `${d.operationId}:f`;
    const sent = done.get(key);
    if (sent) return sent;
    const uploaded: { id: string; title: string }[] = [];
    for (const f of d.content.files ?? []) {
      const bytes = await io.readOutboundFile(f.id);
      const up = await api.call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename: f.name, length: bytes.byteLength }, { repeatable: true });
      await api.upload(up.upload_url, bytes);
      uploaded.push({ id: up.file_id, title: f.name });
    }
    await api.call("files.completeUploadExternal", { files: uploaded, channel_id: channel, ...(root ? { thread_ts: root } : {}), ...(comment ? { initial_comment: comment } : {}) });
    // Slack does not say which message the share became; the id only stands for it.
    const id = `file:${uploaded[0]!.id}`;
    done.set(key, id);
    if (root) joined(channel, root);
    return id;
  };

  const update = async (channel: string, ts: string, content: ImContent) => {
    const { text, blocks } = render(content);
    await api.call("chat.update", { channel, ts, text, blocks }, { repeatable: true });
  };

  return {
    identity: { id: botUserId, name: (await nameOf(botUserId)) ?? auth.user ?? botUserId },

    async deliver(d: ImDelivery) {
      const channel = d.address.conversationId;
      if (d.replaceMessageId) {
        const ts = tsOf(d.replaceMessageId);
        // A file share cannot be edited; it stands as sent.
        if (ts) await update(channel, ts, d.content);
        return { messageId: d.replaceMessageId };
      }
      const root = threadOf(d.threadId ?? d.address.topicId);
      const content = d.content;
      const hasFiles = !!content.files?.length;
      const message = !hasFiles || !!content.actions?.length || !!content.elements?.length;
      const first = message ? await post(d, channel, root) : undefined;
      const shared = hasFiles ? await share(d, channel, root, message ? undefined : content.text) : undefined;
      return { messageId: (first ?? shared)! };
    },

    async download(ref) {
      let known = files.get(ref.id);
      if (!known) {
        const f = (await api.call<{ file?: SFile }>("files.info", { file: ref.id }, { repeatable: true })).file;
        const url = f?.url_private_download ?? f?.url_private;
        if (!url) throw new Error("Slack no longer has that file");
        known = { url, ...(f?.mimetype ? { mimeType: f.mimetype } : {}) };
      }
      return api.download(known.url, known.mimeType);
    },

    async react({ address, messageId: id, reaction }) {
      const ts = tsOf(id);
      if (!ts) return;
      const channel = address.conversationId;
      const name = REACTIONS[reaction];
      const key = `${channel}:${ts}`;
      const previous = reacted.get(key);
      if (previous === name) return;
      if (previous) await api.call("reactions.remove", { channel, timestamp: ts, name: previous }, { repeatable: true }).catch(() => null);
      try { await api.call("reactions.add", { channel, timestamp: ts, name }, { repeatable: true }); }
      catch (e) { if (!(e instanceof SlackError) || e.code !== "already_reacted") throw e; }
      reacted.set(key, name);
    },

    /** The assistant status in the thread ("is thinking…"); Slack clears it with an empty one. */
    async indicate({ address, threadId, state }) {
      const root = threadOf(threadId ?? address.topicId);
      const channel = address.conversationId;
      if (!root || statusless.has(channel)) return;
      const thinking = state !== "idle";
      try {
        if (legacyStatus) {
          try {
            await api.call("assistant.threads.setStatus", { channel_id: channel, thread_ts: root, status: thinking ? THINKING[chinese.get(channel) ? "zh" : "en"] : "" }, { repeatable: true });
            return;
          } catch (e) {
            // Slack is retiring this method for agents.sessions.setStatus.
            if (!(e instanceof SlackError) || !["unknown_method", "method_deprecated", "deprecated_endpoint"].includes(e.code ?? "")) throw e;
            legacyStatus = false;
          }
        }
        await api.call("agents.sessions.setStatus", { channel_id: channel, thread_ts: root, status: thinking ? "processing" : "active" }, { repeatable: true });
      } catch (e) {
        if (e instanceof SlackError && e.disposition === "permanent") statusless.set(channel, true);
        throw e;
      }
    },

    stream: {
      /**
       * Slack's streaming methods, in the thread under the message that
       * asked. They stream into threads only and need the person the reply
       * is for, so a reply at the top of a direct message, or one Slack
       * will not stream, grows by edits instead.
       */
      async start(d) {
        const channel = d.address.conversationId;
        const root = threadOf(d.threadId ?? d.address.topicId);
        const recipient = root ? people.get(`${channel}:${root}`) : undefined;
        if (root && (recipient || isDirect(channel))) {
          const md = markdownOf(d.content.text);
          try {
            const r = await api.call<{ ts: string }>("chat.startStream", { channel, thread_ts: root, markdown_text: md,
              ...(recipient ? { recipient_user_id: recipient, recipient_team_id: team } : {}) });
            joined(channel, root);
            streams.set(r.ts, { channel, text: d.content.text, sent: md, native: true });
            return { messageId: r.ts };
          } catch (e) {
            if (!(e instanceof SlackError) || e.disposition !== "permanent") throw e;
          }
        }
        const ts = await post(d, channel, root);
        streams.set(ts, { channel, text: d.content.text, sent: "", native: false });
        return { messageId: ts };
      },

      async append({ messageId: ts, delta }) {
        const s = streams.get(ts);
        if (!s) return;
        const text = s.text + delta;
        if (!s.native) {
          await update(s.channel, ts, { text });
          s.text = text;
          return;
        }
        const md = markdownOf(text);
        if (md.startsWith(s.sent) && md !== s.sent) {
          try { await api.call("chat.appendStream", { channel: s.channel, ts, markdown_text: md.slice(s.sent.length) }); }
          catch (e) {
            if (!(e instanceof SlackError) || e.disposition !== "permanent") throw e;
            // The stream ended on Slack's side (stopped, or timed out); the rest comes by edits.
            s.native = false;
            await update(s.channel, ts, { text });
          }
          s.sent = md;
        }
        s.text = text;
      },

      /**
       * Ends the stream with whatever it still lacks, then rewrites it as
       * mrkdwn with any controls. Should Slack refuse the rewrite, a reply
       * without controls already stands complete.
       */
      async stop({ messageId: ts, address, content }) {
        const s = streams.get(ts);
        const channel = s?.channel ?? address.conversationId;
        let complete = false;
        if (!s || s.native) {
          const md = markdownOf(content.text);
          const rest = s && md.startsWith(s.sent) ? md.slice(s.sent.length) : null;
          complete = await api.call("chat.stopStream", { channel, ts, ...(rest ? { markdown_text: rest } : {}) }, { repeatable: true }).then(() => rest !== null, () => false);
        }
        try { await update(channel, ts, content); }
        catch (e) {
          if (!complete || content.actions?.length || content.elements?.length || !(e instanceof SlackError) || e.disposition !== "permanent") throw e;
        }
        streams.delete(ts);
        return { messageId: ts };
      }
    },

    close() {
      gateway.stop();
      streams.clear();
    }
  };
}
