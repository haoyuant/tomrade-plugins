import { createHash } from "node:crypto";
import type { ImAdapter, ImAdapterSession, ImAddress, ImCapabilities, ImContent, ImContextMessage, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { Api, BASE, type Domain, FeishuError, net, NO_SCOPE, type Net } from "./api.js";
import { cardOf, controlOf, STREAM_ELEMENT } from "./card.js";
import { LongConnection } from "./gateway.js";
import { addressOf, fileId, menuCommand, parseFileId, parseMessage, REACTIONS, type FCardAction, type FEnvelope, type FileRef, type FMenu, type FMessageEvent, type FRecalled } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  // A card holds 30 KB of JSON; 6000 characters of Chinese stay well inside it.
  maxTextLength: 6000, maxFileBytes: 30 * 1024 * 1024,
  // A group is one conversation and replies quote the message that asked; a message written in a topic is answered in it.
  threads: false, reactions: true, typing: false, stream: "native",
  select: true, multiSelect: true, textInput: true, cards: true, cardUpdate: true,
  nativeCommands: false, ephemeral: false, markdown: "lark",
  // Feishu allows a bot five messages a second in one chat.
  rateLimit: { messages: 5, windowMs: 1000 }
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

/** Feishu deduplicates a message by its uuid for an hour, so a retry after a lost answer never posts twice. */
const uuidOf = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 32);

/**
 * A card's updates must carry a rising sequence. Tenths of a second since 2025
 * keep rising across restarts too, where a counter would start again at one.
 */
const EPOCH = Date.UTC(2025, 0, 1);
let lastSequence = 0;
const nextSequence = () => (lastSequence = Math.max(lastSequence + 1, Math.floor((Date.now() - EPOCH) / 100)));

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/bmp", "image/x-icon"]);
const IMAGE_BYTES = 10 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = { pdf: "pdf", doc: "doc", docx: "doc", xls: "xls", xlsx: "xls", ppt: "ppt", pptx: "ppt" };
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

export interface FeishuOptions { domain: Domain; net?: Net; backoffMs?: number; livenessMs?: number }

export async function openFeishu(connectionId: string, io: IO, opts: FeishuOptions): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const appId = io.credentials.appId?.trim() ?? "";
  const appSecret = io.credentials.appSecret?.trim() ?? "";
  if (!appId || !appSecret) throw new Error("The App ID and App Secret are both needed");
  const api = new Api(BASE[opts.domain], { appId, appSecret }, n);
  const submit = opts.domain === "lark" ? "Submit" : "确定";

  // Who the credentials sign in as; a wrong secret fails here, in Feishu's words.
  const info = await api.call<{ bot?: { open_id?: string; app_name?: string }; data?: { bot?: { open_id?: string; app_name?: string } } }>("GET", "/open-apis/bot/v3/info");
  const bot = info.bot ?? info.data?.bot ?? {};
  const botOpenId = bot.open_id ?? "";

  /** Messages this bot posted, and what they said, so a reply to one activates it and can be quoted. */
  const sent = new Recent<string>(1000);
  /** Topics this bot has answered in; a follow-up there needs no @. */
  const topics = new Recent<true>(500);
  /** A person's recent messages, so a withdrawal can be told to the IM layer as theirs. */
  const known = new Recent<{ actor: string; address: ImAddress }>(1000);
  /** A person's direct chat, learned from their messages, for the bot menu (which names no chat). */
  const directChats = new Recent<string>(500);
  const names = new Recent<string | null>(500);
  let namesAllowed = true;
  const contexts = new Recent<ImContextMessage | null>(200);
  const fetched = new Recent<Uint8Array>(16);
  const reacted = new Recent<{ emoji: string; id: string }>(500);
  /** Card entities behind messages, which only the card API can update. */
  const cardIds = new Recent<string>(500);
  const streams = new Map<string, { cardId?: string; text: string; topic?: string }>();
  let cardkit = true;

  // Events reach the IM layer one at a time, in Feishu's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  const nameOf = async (openId: string): Promise<string | undefined> => {
    if (names.has(openId) || !namesAllowed) return names.get(openId) ?? undefined;
    let name: string | null = null;
    try {
      const r = await api.call<{ data?: { user?: { name?: string } } }>("GET", `/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`);
      name = r.data?.user?.name || null;
    } catch (e) {
      // Without the contact scope nobody's name can be read; stop asking.
      if (e instanceof FeishuError && e.code !== undefined && NO_SCOPE.has(e.code)) namesAllowed = false;
    }
    names.set(openId, name);
    return name ?? undefined;
  };

  /** An earlier message's text and author, read once. */
  const readMessage = async (id: string, role: ImContextMessage["role"]): Promise<ImContextMessage | null> => {
    const key = `${role}:${id}`;
    if (contexts.has(key)) return contexts.get(key)!;
    let found: ImContextMessage | null = null;
    const ours = sent.get(id);
    if (ours !== undefined) found = ours.trim() ? { role, messageId: id, author: { id: botOpenId, ...(bot.app_name ? { name: bot.app_name } : {}), isBot: true }, text: ours } : null;
    else {
      try {
        const r = await api.call<{ data?: { items?: { message_id: string; msg_type: string; body?: { content?: string }; sender?: { id?: string; id_type?: string; sender_type?: string }; mentions?: { key: string; id: string; name: string }[] }[] } }>("GET", `/open-apis/im/v1/messages/${encodeURIComponent(id)}`);
        const m = r.data?.items?.[0];
        if (m?.body?.content && m.sender?.id) {
          const text = parseMessage({ message_id: m.message_id, chat_id: "", chat_type: "", message_type: m.msg_type, content: m.body.content,
            mentions: (m.mentions ?? []).map(x => ({ key: x.key, id: { open_id: x.id }, name: x.name })) }, botOpenId).text;
          const isBot = m.sender.sender_type === "app";
          const name = isBot ? (m.sender.id === appId ? bot.app_name : undefined) : await nameOf(m.sender.id);
          if (text) found = { role, messageId: id, author: { id: m.sender.id, ...(name ? { name } : {}), isBot }, text };
        }
      } catch { /* without the read scope there is no context to add */ }
    }
    contexts.set(key, found);
    return found;
  };

  /** Sizes and types for a message's files, read from the headers; the IM layer checks the bytes against them. */
  const probe = async (messageId: string, files: FileRef[]) => {
    const out: NonNullable<(ImInbound & { kind: "message" })["attachments"]> = [];
    for (const [i, f] of files.slice(0, 8).entries()) {
      try {
        const id = fileId(messageId, f);
        const got = await api.fetchFile(resourcePath(messageId, f.type, f.key), { probe: true });
        if (got.bytes) fetched.set(id, got.bytes);
        if (got.size <= 0) continue;
        const mimeType = got.mimeType && got.mimeType !== "application/octet-stream" ? got.mimeType : f.type === "image" ? "image/png" : "application/octet-stream";
        const name = f.name ?? got.name ?? (f.type === "image" ? `image-${i + 1}.${EXT[mimeType] ?? "png"}` : `file-${i + 1}`);
        out.push({ id, name: name.slice(0, 255), mimeType: mimeType.slice(0, 128), size: got.size });
      } catch { /* a file Feishu will not hand over is left out */ }
    }
    return out;
  };
  const resourcePath = (messageId: string, type: string, key: string) => `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`;

  const onMessage = async (env: FEnvelope<FMessageEvent>) => {
    const { sender, message: m } = env.event;
    const actorId = sender.sender_id.open_id;
    if (sender.sender_type !== "user" || !actorId) return;
    const dm = m.chat_type === "p2p";
    if (dm) directChats.set(actorId, m.chat_id);
    const parsed = parseMessage(m, botOpenId);
    const address = addressOf(env.header.tenant_key ?? sender.tenant_key ?? "", m);
    const replied = (!!m.parent_id && sent.has(m.parent_id)) || (!!address.topicId && (sent.has(address.topicId) || topics.has(address.topicId)));
    const activation = dm ? "dm" : parsed.mentioned ? "mention" : replied ? "reply" : "ambient";
    if (activation === "ambient" && !parsed.text) return;
    known.set(m.message_id, { actor: actorId, address });
    const attachments = activation === "ambient" ? [] : await probe(m.message_id, parsed.files);
    if (!parsed.text && !attachments.length) return;
    const context: ImContextMessage[] = [];
    if (activation !== "ambient") {
      const quoted = m.parent_id ? await readMessage(m.parent_id, "quoted") : null;
      if (quoted) context.push(quoted);
      if (address.topicId && address.topicId !== m.parent_id && address.topicId !== m.message_id) {
        const root = await readMessage(address.topicId, "root");
        if (root) context.push(root);
      }
    }
    const name = await nameOf(actorId);
    await receive({
      kind: "message", eventId: env.header.event_id, messageId: m.message_id, text: parsed.text, activation,
      actor: { id: actorId, ...(name ? { name } : {}), isBot: false }, address,
      ...(attachments.length ? { attachments } : {}),
      ...(m.parent_id ? { replyTo: m.parent_id } : {}),
      ...(context.length ? { context } : {})
    });
  };

  /** Answered at once, inside Feishu's three seconds; the outcome updates the card later. */
  const onAction = (env: FEnvelope<FCardAction>) => {
    const ev = env.event;
    const parsed = controlOf(ev.action);
    const actorId = ev.operator?.open_id;
    const chat = ev.context?.open_chat_id;
    if (!parsed || !actorId || !chat) return {};
    const address: ImAddress = { tenantId: env.header.tenant_key ?? ev.operator.tenant_key ?? "", conversationId: chat, ...(parsed.control.a ? { topicId: parsed.control.a } : {}) };
    later(() => receive({ kind: "action", eventId: env.header.event_id, token: parsed.control.t, ...(parsed.value !== undefined ? { value: parsed.value } : {}),
      actor: { id: actorId, isBot: false }, address }));
    return {};
  };

  const onEvent = (payload: Record<string, unknown>): unknown => {
    const env = payload as unknown as FEnvelope<unknown>;
    if (!env.header?.event_id || !env.event) return undefined;
    switch (env.header.event_type) {
      case "im.message.receive_v1":
        later(() => onMessage(env as FEnvelope<FMessageEvent>));
        return undefined;
      case "card.action.trigger":
        return onAction(env as FEnvelope<FCardAction>);
      case "im.message.recalled_v1": {
        const id = (env.event as FRecalled).message_id;
        const k = known.get(id);
        if (k) later(() => receive({ kind: "retract", eventId: env.header.event_id, messageId: id, actor: { id: k.actor, isBot: false }, address: k.address }));
        return undefined;
      }
      case "application.bot.menu_v6": {
        const ev = env.event as FMenu;
        const actorId = ev.operator?.operator_id?.open_id;
        const chat = actorId ? directChats.get(actorId) : undefined;
        if (!actorId || !chat || !ev.event_key) return undefined;
        later(() => receive({ kind: "message", eventId: env.header.event_id, messageId: `menu:${env.header.event_id}`, text: menuCommand(ev.event_key), activation: "dm",
          actor: { id: actorId, isBot: false }, address: { tenantId: env.header.tenant_key ?? "", conversationId: chat } }));
        return undefined;
      }
    }
    return undefined;
  };

  const connection = new LongConnection(api, n, {
    event: onEvent,
    state: (state, detail) => io.status(state, detail)
  }, { ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.livenessMs !== undefined ? { livenessMs: opts.livenessMs } : {}) });
  io.signal.addEventListener("abort", () => connection.stop(), { once: true });
  await connection.start();

  /** Posts one message: into the topic, as a quote reply, or plainly into the chat. */
  const post = async (d: ImDelivery, msgType: string, content: string, part: string): Promise<string> => {
    const uuid = uuidOf(d.operationId, part);
    const body = { msg_type: msgType, content, uuid };
    const r = d.threadId ? await api.call<{ data: { message_id: string } }>("POST", `/open-apis/im/v1/messages/${encodeURIComponent(d.threadId)}/reply`, { ...body, reply_in_thread: true })
      : d.replyTo ? await api.call<{ data: { message_id: string } }>("POST", `/open-apis/im/v1/messages/${encodeURIComponent(d.replyTo)}/reply`, body)
      : await api.call<{ data: { message_id: string } }>("POST", "/open-apis/im/v1/messages?receive_id_type=chat_id", { ...body, receive_id: d.address.conversationId });
    const id = r.data.message_id;
    sent.set(id, msgType === "interactive" ? d.content.text : "");
    if (d.threadId) topics.set(d.threadId, true);
    return id;
  };

  const sendFile = async (d: ImDelivery, f: NonNullable<ImContent["files"]>[number], i: number): Promise<string> => {
    const bytes = await io.readOutboundFile(f.id);
    const blob = new Blob([new Uint8Array(bytes)], { type: f.mimeType });
    if (IMAGE_TYPES.has(f.mimeType) && bytes.byteLength <= IMAGE_BYTES) {
      const form = new FormData();
      form.append("image_type", "message");
      form.append("image", blob, f.name);
      const up = await api.call<{ data: { image_key: string } }>("POST", "/open-apis/im/v1/images", form);
      return post(d, "image", JSON.stringify({ image_key: up.data.image_key }), `f${i}`);
    }
    const form = new FormData();
    form.append("file_type", FILE_TYPES[f.name.split(".").pop()?.toLowerCase() ?? ""] ?? "stream");
    form.append("file_name", f.name);
    form.append("file", blob, f.name);
    const up = await api.call<{ data: { file_key: string } }>("POST", "/open-apis/im/v1/files", form);
    return post(d, "file", JSON.stringify({ file_key: up.data.file_key }), `f${i}`);
  };

  const replaceCard = (cardId: string, card: Record<string, unknown>) => {
    const sequence = nextSequence();
    return api.call("PUT", `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, { card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: uuidOf(cardId, String(sequence)) });
  };

  /** Rewrites a card in place: a card entity through the card API, any other card by patching the message. */
  const update = async (messageId: string, content: ImContent, topic: string | undefined) => {
    const card = cardOf(content, { ...(topic ? { topic } : {}), submit });
    // An entity that was streaming stays out of streaming mode once rewritten.
    const entity = () => cardOf(content, { ...(topic ? { topic } : {}), submit, streaming: false });
    const cardId = cardIds.get(messageId);
    if (cardId) { await replaceCard(cardId, entity()); return; }
    try {
      await api.call("PATCH", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content: JSON.stringify(card) });
    } catch (e) {
      if (!(e instanceof FeishuError) || e.disposition !== "permanent") throw e;
      // A streamed card from before a restart: find its entity and update that.
      const converted = await api.call<{ data?: { card_id?: string } }>("POST", "/open-apis/cardkit/v1/cards/id_convert", { message_id: messageId }).catch(() => null);
      const id = converted?.data?.card_id;
      if (!id) throw e;
      cardIds.set(messageId, id);
      await replaceCard(id, entity());
    }
  };

  return {
    identity: { id: botOpenId || appId, ...(bot.app_name ? { name: bot.app_name } : {}) },

    async deliver(d: ImDelivery) {
      const topic = d.address.topicId;
      if (d.replaceMessageId) {
        await update(d.replaceMessageId, d.content, topic);
        return { messageId: d.replaceMessageId };
      }
      const files = d.content.files ?? [];
      const card = !!d.content.text || !!d.content.actions?.length || !!d.content.elements?.length || !files.length;
      let first: string | undefined;
      if (card) first = await post(d, "interactive", JSON.stringify(cardOf(d.content, { ...(topic ? { topic } : {}), submit })), "card");
      for (const [i, f] of files.entries()) {
        const id = await sendFile(d, f, i);
        first ??= id;
      }
      return { messageId: first! };
    },

    async download(ref) {
      const cached = fetched.get(ref.id);
      if (cached) return cached;
      const f = parseFileId(ref.id);
      if (!f) throw new Error("Attachment is not one this adapter knows");
      const got = await api.fetchFile(resourcePath(f.messageId, f.type, f.key));
      return got.bytes!;
    },

    async react({ messageId, reaction }) {
      if (messageId.startsWith("menu:")) return;
      const emoji = REACTIONS[reaction];
      const previous = reacted.get(messageId);
      if (previous?.emoji === emoji) return;
      if (previous) await api.call("DELETE", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(previous.id)}`).catch(() => null);
      const r = await api.call<{ data: { reaction_id: string } }>("POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, { reaction_type: { emoji_type: emoji } });
      reacted.set(messageId, { emoji, id: r.data.reaction_id });
    },

    stream: {
      async start(d) {
        const topic = d.address.topicId;
        if (cardkit) {
          let cardId: string | null = null;
          try {
            const created = await api.call<{ data: { card_id: string } }>("POST", "/open-apis/cardkit/v1/cards", {
              type: "card_json", data: JSON.stringify(cardOf({ text: d.content.text || "…" }, { ...(topic ? { topic } : {}), submit, streaming: true }))
            });
            cardId = created.data.card_id;
          } catch (e) {
            if (!(e instanceof FeishuError) || e.disposition !== "permanent") throw e;
            // No card scope: streamed replies become a card that is edited as it grows.
            cardkit = false;
          }
          if (cardId) {
            const id = await post(d, "interactive", JSON.stringify({ type: "card", data: { card_id: cardId } }), "stream");
            cardIds.set(id, cardId);
            streams.set(id, { cardId, text: d.content.text, ...(topic ? { topic } : {}) });
            return { messageId: id };
          }
        }
        const id = await post(d, "interactive", JSON.stringify(cardOf(d.content, { ...(topic ? { topic } : {}), submit })), "stream");
        streams.set(id, { text: d.content.text, ...(topic ? { topic } : {}) });
        return { messageId: id };
      },

      async append({ messageId, delta }) {
        const s = streams.get(messageId);
        if (!s) return;
        // The whole text each time: a lost update only delays what the card shows.
        s.text += delta;
        if (s.cardId) {
          const sequence = nextSequence();
          await api.call("PUT", `/open-apis/cardkit/v1/cards/${encodeURIComponent(s.cardId)}/elements/${STREAM_ELEMENT}/content`, { content: s.text, sequence, uuid: uuidOf(s.cardId, String(sequence)) });
        } else await update(messageId, { text: s.text }, s.topic);
      },

      async stop({ messageId, address, content }) {
        const s = streams.get(messageId);
        if (s?.cardId) {
          const sequence = nextSequence();
          await api.call("PATCH", `/open-apis/cardkit/v1/cards/${encodeURIComponent(s.cardId)}/settings`, {
            settings: JSON.stringify({ config: { streaming_mode: false } }), sequence, uuid: uuidOf(s.cardId, String(sequence))
          }).catch(() => null);
        }
        await update(messageId, content, s?.topic ?? address.topicId);
        streams.delete(messageId);
        return { messageId };
      }
    },

    close() {
      connection.stop();
      streams.clear();
    }
  };
}
