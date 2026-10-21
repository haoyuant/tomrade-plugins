import type { Net } from "./api.js";
import { decodeFrame, encodeFrame, type Frame, FrameMethod, header } from "./proto.js";

/** A REST call the fake received. */
export interface FakeCall { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> | null; at: number }
/** A message on the fake's side: what a person sent, or what the bot posted. */
export interface FakeMessage {
  id: string; chat: string; chatType: "p2p" | "group"; sender: string; msgType: string; content: string;
  parent?: string; root?: string; thread?: string; uuid?: string; cardId?: string; mentionsBot?: boolean;
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/**
 * Feishu in memory: the long-connection endpoint and a socket speaking its
 * frames (ping, pong, events in one or several parts, acknowledgements), and
 * REST routes for tokens, messages, replies, reactions, files, cards,
 * chat info and CardKit. For tests and the plugin's own scenario; never shipped as the adapter.
 */
export class FakeFeishu {
  readonly appId = "cli_a1b2c3d4e5f60718";
  readonly appSecret = "fake-secret";
  readonly bot = { open_id: "ou_bot", app_name: "Tomrade Bot" };
  readonly tenant = "tenant-1";
  readonly calls: FakeCall[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly cards = new Map<string, { card: Record<string, unknown>; text: string; sequence: number; streaming: boolean }>();
  readonly reactions: { messageId: string; emoji: string; id: string; removed: boolean }[] = [];
  /** What the adapter answered to each event, by event id. */
  readonly answers = new Map<string, { code: number; data?: unknown; at: number }>();
  readonly users = new Map<string, string>();
  readonly files = new Map<string, { bytes: Uint8Array; type: string }>();
  /** Each chat's mode as the chat API tells it; a chat a person wrote in is added. */
  readonly chats = new Map<string, "p2p" | "group" | "topic">();
  /** Seconds, as Feishu sends it. */
  pingInterval = 120;
  /** When set, pings go unanswered, as on a dead connection. */
  silent = false;
  /** When set, the app has no CardKit scope. */
  noCardkit = false;
  /** When set, the app may not read contacts. */
  noContact = false;
  /** When set, the app may not read chat info. */
  noChatInfo = false;
  /** Pings received across connections. */
  pings = 0;
  /** Event ids sent, so a test can tell when one is answered. */
  readonly sentAt = new Map<string, number>();
  private ids = 1000;
  private tokens = new Set<string>();
  private fail: { match: (c: FakeCall) => boolean; status: number; code: number; retryAfter?: number; msg?: string; times: number }[] = [];

  get live() { const s = this.sockets.at(-1); return s && s.readyState === 1 ? s : null; }

  net(): Net {
    const fake = this;
    class Socket extends FakeSocket { constructor(url: string) { super(fake, url); } }
    return { fetch: (input, init) => this.fetch(String(input), init), WebSocket: Socket as unknown as typeof WebSocket };
  }

  id(prefix: string) { return `${prefix}${++this.ids}`; }

  /** Answers the next calls `match` picks with `status` and Feishu's `code` (a 429 carries the reset header). */
  failNext(match: (c: FakeCall) => boolean, status: number, code: number, opts: { retryAfter?: number; times?: number; msg?: string } = {}) {
    this.fail.push({ match, status, code, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), ...(opts.msg ? { msg: opts.msg } : {}), times: opts.times ?? 1 });
  }

  /** Every token handed out so far stops working, as when Feishu rotates them. */
  expireTokens() { this.tokens.clear(); }

  /** The connection breaks; the client should ask for a new address and reconnect. */
  drop() { this.sockets.at(-1)?.serverClose(1006); }

  /** Sends an event to the live connection, split into `parts` frames when asked. */
  event(type: string, event: unknown, opts: { eventId?: string; parts?: number } = {}) {
    const eventId = opts.eventId ?? this.id("ev_");
    const payload = new TextEncoder().encode(JSON.stringify({ schema: "2.0", header: { event_id: eventId, event_type: type, tenant_key: this.tenant, app_id: this.appId, create_time: String(Date.now()) }, event }));
    const parts = Math.max(1, opts.parts ?? 1);
    const size = Math.ceil(payload.length / parts);
    const messageId = this.id("frame_");
    this.sentAt.set(eventId, Date.now());
    for (let seq = 0; seq < parts; seq++) {
      this.live?.push({ SeqID: BigInt(seq + 1), LogID: 9007199254740993n, service: 33, method: FrameMethod.data,
        headers: [{ key: "type", value: "event" }, { key: "message_id", value: messageId }, { key: "sum", value: String(parts) }, { key: "seq", value: String(seq) }, { key: "trace_id", value: eventId }],
        payload: payload.slice(seq * size, (seq + 1) * size) });
    }
    return eventId;
  }

  /** A person sends a message; `mention` @s the bot. */
  message(o: { chat: string; sender: string; text?: string; chatType?: "p2p" | "group"; mention?: boolean; parent?: string; root?: string; thread?: string;
    id?: string; type?: string; content?: Record<string, unknown>; parts?: number; eventId?: string }) {
    const id = o.id ?? this.id("om_");
    const chatType = o.chatType ?? "p2p";
    const content = o.content ?? { text: `${o.mention ? "@_user_1 " : ""}${o.text ?? ""}` };
    const m: FakeMessage = { id, chat: o.chat, chatType, sender: o.sender, msgType: o.type ?? "text", content: JSON.stringify(content),
      ...(o.parent ? { parent: o.parent } : {}), ...(o.root ? { root: o.root } : {}), ...(o.thread ? { thread: o.thread } : {}), ...(o.mention ? { mentionsBot: true } : {}) };
    this.messages.set(id, m);
    if (!this.chats.has(o.chat)) this.chats.set(o.chat, chatType);
    const event = {
      sender: { sender_id: { open_id: o.sender }, sender_type: "user", tenant_key: this.tenant },
      message: { message_id: id, chat_id: o.chat, chat_type: chatType, message_type: m.msgType, content: m.content, create_time: String(Date.now()),
        ...(o.parent ? { parent_id: o.parent } : {}), ...(o.root ? { root_id: o.root } : {}), ...(o.thread ? { thread_id: o.thread } : {}),
        ...(o.mention ? { mentions: [{ key: "@_user_1", id: { open_id: this.bot.open_id }, name: this.bot.app_name }] } : {}) }
    };
    const eventId = this.event("im.message.receive_v1", event, { ...(o.parts ? { parts: o.parts } : {}), ...(o.eventId ? { eventId: o.eventId } : {}) });
    return { id, eventId, event };
  }

  /** A person presses a card control; `form` is what its form held. */
  press(o: { messageId: string; operator: string; value: unknown; form?: Record<string, unknown> }) {
    const m = this.messages.get(o.messageId);
    return this.event("card.action.trigger", {
      operator: { open_id: o.operator, tenant_key: this.tenant }, token: this.id("c-"),
      action: { tag: "button", value: o.value, ...(o.form ? { form_value: o.form, name: "submit0" } : {}) },
      host: "im_message", context: { open_message_id: o.messageId, open_chat_id: m?.chat ?? "" }
    });
  }

  /** The bot's posts in a chat, oldest first, with their cards parsed. */
  posted(chat: string) {
    return [...this.messages.values()].filter(m => m.chat === chat && m.sender === this.bot.open_id).map(m => ({ ...m, card: this.cardOf(m) }));
  }

  /** A message's card as it now stands: an entity's latest version, or the message's own JSON. */
  cardOf(m: FakeMessage): Record<string, unknown> | null {
    if (m.cardId) return this.cards.get(m.cardId)?.card ?? null;
    if (m.msgType !== "interactive") return null;
    return JSON.parse(m.content) as Record<string, unknown>;
  }

  /** The Markdown a card shows, joined. */
  textOf(card: Record<string, unknown> | null): string {
    const elements = ((card?.body as { elements?: { tag: string; content?: string }[] } | undefined)?.elements ?? []);
    return elements.filter(e => e.tag === "markdown").map(e => e.content ?? "").join("\n");
  }

  where(method: string, path: RegExp) { return this.calls.filter(c => c.method === method && path.test(c.path)); }

  // ── Long connection ──────────────────────────────────────────────────

  open(socket: FakeSocket) {
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("open", {}));
  }

  receive(socket: FakeSocket, f: Frame) {
    if (f.method === FrameMethod.control && header(f, "type") === "ping") {
      this.pings++;
      if (!this.silent) socket.push({ ...f, headers: [{ key: "type", value: "pong" }], payload: new TextEncoder().encode(JSON.stringify({ PingInterval: this.pingInterval })) });
      return;
    }
    if (f.method === FrameMethod.data) {
      const eventId = header(f, "trace_id") ?? "";
      const answer = JSON.parse(new TextDecoder().decode(f.payload)) as { code: number; data?: string };
      if (f.LogID !== 9007199254740993n) throw new Error("acknowledgement lost the frame's LogID");
      this.answers.set(eventId, { code: answer.code, ...(answer.data ? { data: JSON.parse(Buffer.from(answer.data, "base64").toString()) } : {}), at: Date.now() });
    }
  }

  // ── REST ─────────────────────────────────────────────────────────────

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const method = init.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (init.body instanceof FormData) {
      body = {};
      for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : { name: (v as File).name, size: (v as File).size };
    } else if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    const call: FakeCall = { method, path: u.pathname, query: u.searchParams, body, at: Date.now() };
    this.calls.push(call);
    const p = u.pathname;

    if (p === "/callback/ws/endpoint") {
      if (body?.AppID !== this.appId || body?.AppSecret !== this.appSecret) return json({ code: 403, msg: "app forbidden" });
      return json({ code: 0, data: { URL: `wss://msg-frontier.feishu.cn/ws/v2?device_id=7&service_id=33&ticket=t${this.sockets.length}`, ClientConfig: { PingInterval: this.pingInterval, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 } } });
    }
    if (p === "/open-apis/auth/v3/tenant_access_token/internal") {
      if (body?.app_id !== this.appId || body?.app_secret !== this.appSecret) return json({ code: 10014, msg: "app secret invalid" }, 400);
      const token = `t-${this.id("")}`;
      this.tokens.add(token);
      return json({ code: 0, msg: "ok", tenant_access_token: token, expire: 7200 });
    }
    const auth = (init.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, "");
    if (!auth || !this.tokens.has(auth)) return json({ code: 99991663, msg: "Invalid access token for authorization." }, 400);
    const failing = this.fail.find(f => f.times > 0 && f.match(call));
    if (failing) {
      failing.times--;
      return json({ code: failing.code, msg: failing.msg ?? "failure" }, failing.status, failing.retryAfter !== undefined ? { "x-ogw-ratelimit-reset": String(failing.retryAfter) } : {});
    }

    let m: RegExpExecArray | null;
    if (method === "GET" && p === "/open-apis/bot/v3/info") return json({ code: 0, msg: "ok", bot: { ...this.bot, activate_status: 2 } });
    if (method === "POST" && p === "/open-apis/im/v1/messages") return this.post(body!, String(body!.receive_id), undefined, false);
    if (method === "POST" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(p))) {
      const parent = this.messages.get(m[1]!);
      if (!parent) return json({ code: 230011, msg: "message not found" }, 400);
      return this.post(body!, parent.chat, parent, !!body!.reply_in_thread);
    }
    if (method === "PATCH" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(p))) {
      const msg = this.messages.get(m[1]!);
      if (!msg) return json({ code: 230011, msg: "message not found" }, 400);
      if (msg.cardId) return json({ code: 230099, msg: "card entity message can only be updated through cardkit" }, 400);
      msg.content = String(body!.content);
      return json({ code: 0, msg: "ok", data: {} });
    }
    if (method === "GET" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(p))) {
      const msg = this.messages.get(m[1]!);
      if (!msg) return json({ code: 230011, msg: "message not found" }, 400);
      return json({ code: 0, data: { items: [{ message_id: msg.id, msg_type: msg.msgType, body: { content: msg.content },
        sender: { id: msg.sender === this.bot.open_id ? this.appId : msg.sender, id_type: msg.sender === this.bot.open_id ? "app_id" : "open_id", sender_type: msg.sender === this.bot.open_id ? "app" : "user" },
        ...(msg.mentionsBot ? { mentions: [{ key: "@_user_1", id: this.bot.open_id, id_type: "open_id", name: this.bot.app_name }] } : {}) }] } });
    }
    if (method === "GET" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(p))) {
      const f = this.files.get(m[2]!);
      if (!f) return json({ code: 234003, msg: "file not found" }, 400);
      return new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type, "content-length": String(f.bytes.byteLength) } });
    }
    if (method === "POST" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/.exec(p))) {
      const id = this.id("r_");
      this.reactions.push({ messageId: m[1]!, emoji: String((body!.reaction_type as { emoji_type: string }).emoji_type), id, removed: false });
      return json({ code: 0, data: { reaction_id: id } });
    }
    if (method === "DELETE" && (m = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(p))) {
      const r = this.reactions.find(x => x.id === m![2]);
      if (r) r.removed = true;
      return json({ code: 0, data: {} });
    }
    if (method === "POST" && p === "/open-apis/im/v1/images") return json({ code: 0, data: { image_key: this.id("img_") } });
    if (method === "POST" && p === "/open-apis/im/v1/files") return json({ code: 0, data: { file_key: this.id("file_") } });
    if (method === "GET" && (m = /^\/open-apis\/contact\/v3\/users\/([^/]+)$/.exec(p))) {
      if (this.noContact) return json({ code: 99991672, msg: "Access denied. One of the following scopes is required: [contact:user.base:readonly]" }, 400);
      const name = this.users.get(decodeURIComponent(m[1]!));
      return name ? json({ code: 0, data: { user: { name } } }) : json({ code: 41050, msg: "no user authority" }, 400);
    }
    if (method === "GET" && (m = /^\/open-apis\/im\/v1\/chats\/([^/]+)$/.exec(p))) {
      if (this.noChatInfo) return json({ code: 99991672, msg: "Access denied. One of the following scopes is required: [im:chat:readonly]" }, 400);
      const mode = this.chats.get(decodeURIComponent(m[1]!));
      return mode ? json({ code: 0, data: { chat_mode: mode, chat_type: mode === "p2p" ? "" : "private" } }) : json({ code: 232011, msg: "operator not in the chat" }, 400);
    }
    if (p.startsWith("/open-apis/cardkit/v1/cards")) return this.cardkit(method, p, body);
    return json({ code: 404, msg: "404 page not found" }, 404);
  }

  private post(body: Record<string, unknown>, chat: string, parent: FakeMessage | undefined, inThread: boolean) {
    const same = [...this.messages.values()].find(x => body.uuid && x.uuid === body.uuid);
    if (same) return json({ code: 0, data: { message_id: same.id, chat_id: same.chat } });
    const id = this.id("om_");
    const content = String(body.content);
    const parsed = JSON.parse(content) as { type?: string; data?: { card_id?: string } };
    const cardId = body.msg_type === "interactive" && parsed.type === "card" ? parsed.data?.card_id : undefined;
    const root = parent ? parent.root ?? parent.id : undefined;
    const known = parent ? this.messages.get(parent.id) : undefined;
    this.messages.set(id, { id, chat, chatType: known?.chatType ?? "p2p", sender: this.bot.open_id, msgType: String(body.msg_type), content,
      ...(parent ? { parent: parent.id, root } : {}), ...(inThread || parent?.thread ? { thread: parent?.thread ?? `omt_${root}` } : {}),
      ...(body.uuid ? { uuid: String(body.uuid) } : {}), ...(cardId ? { cardId } : {}) });
    return json({ code: 0, data: { message_id: id, chat_id: chat } });
  }

  private cardkit(method: string, p: string, body: Record<string, unknown> | null) {
    let m: RegExpExecArray | null;
    if (method === "POST" && p === "/open-apis/cardkit/v1/cards") {
      if (this.noCardkit) return json({ code: 99991672, msg: "Access denied. One of the following scopes is required: [cardkit:card:write]" }, 400);
      const card = JSON.parse(String(body!.data)) as Record<string, unknown>;
      const id = this.id("card_");
      this.cards.set(id, { card, text: this.textOf(card), sequence: 0, streaming: !!(card.config as { streaming_mode?: boolean } | undefined)?.streaming_mode });
      return json({ code: 0, data: { card_id: id } });
    }
    if (method === "POST" && p === "/open-apis/cardkit/v1/cards/id_convert") {
      const msg = this.messages.get(String(body!.message_id));
      return msg?.cardId ? json({ code: 0, data: { card_id: msg.cardId } }) : json({ code: 300301, msg: "card not found" }, 400);
    }
    const card = (id: string) => this.cards.get(id);
    const sequenced = (c: { sequence: number }) => {
      const s = Number(body!.sequence);
      if (!(s > c.sequence)) return json({ code: 300317, msg: "sequence number compare failed" }, 400);
      c.sequence = s;
      return null;
    };
    if (method === "PUT" && (m = /^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/elements\/([^/]+)\/content$/.exec(p))) {
      const c = card(m[1]!);
      if (!c) return json({ code: 300301, msg: "card not found" }, 400);
      if (!c.streaming) return json({ code: 300309, msg: "streaming mode is closed" }, 400);
      const refused = sequenced(c);
      if (refused) return refused;
      c.text = String(body!.content);
      const el = ((c.card.body as { elements: { element_id?: string; content?: string }[] }).elements).find(e => e.element_id === m![2]);
      if (el) el.content = c.text;
      return json({ code: 0, data: {} });
    }
    if (method === "PATCH" && (m = /^\/open-apis\/cardkit\/v1\/cards\/([^/]+)\/settings$/.exec(p))) {
      const c = card(m[1]!);
      if (!c) return json({ code: 300301, msg: "card not found" }, 400);
      const refused = sequenced(c);
      if (refused) return refused;
      const settings = JSON.parse(String(body!.settings)) as { config?: { streaming_mode?: boolean } };
      if (settings.config?.streaming_mode === false) c.streaming = false;
      return json({ code: 0, data: {} });
    }
    if (method === "PUT" && (m = /^\/open-apis\/cardkit\/v1\/cards\/([^/]+)$/.exec(p))) {
      const c = card(m[1]!);
      if (!c) return json({ code: 300301, msg: "card not found" }, 400);
      const refused = sequenced(c);
      if (refused) return refused;
      c.card = JSON.parse(String((body!.card as { data: string }).data)) as Record<string, unknown>;
      c.text = this.textOf(c.card);
      c.streaming = !!(c.card.config as { streaming_mode?: boolean } | undefined)?.streaming_mode;
      return json({ code: 0, data: {} });
    }
    return json({ code: 404, msg: "404 page not found" }, 404);
  }
}

export class FakeSocket {
  readyState = 1;
  binaryType = "blob";
  private listeners = new Map<string, Listener[]>();
  constructor(private readonly fake: FakeFeishu, readonly url: string) { fake.open(this); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string }) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  push(frame: Frame) {
    if (this.readyState !== 1) return;
    const bytes = encodeFrame(frame);
    this.emit("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  send(data: Uint8Array) { if (this.readyState === 1) this.fake.receive(this, decodeFrame(new Uint8Array(data))); }
  close(code = 1000) { this.serverClose(code); }
  serverClose(code: number, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }
}
