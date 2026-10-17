import type { Net } from "./api.js";

/** A REST call the fake received. */
export interface FakeCall { method: string; host: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: Record<string, unknown> | null; at: number }
/** An AI card as it now stands. */
export interface FakeCard { id: string; template: string; params: Record<string, string>; streamed: string; finalized: boolean; atUserIds?: Record<string, string> }
/** What the robot posted, where (`user:<id>` for a direct chat, the group's id) and how. */
export interface FakePost { id: string; conversation: string; via: "card" | "webhook" | "api"; kind: string; text: string; at?: string[]; card?: FakeCard; param?: Record<string, unknown> }

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json;charset=utf-8", ...headers } });

/** Where DingTalk keeps the files people send, as its download addresses name it. */
export const STORAGE = "wukong-file-im-zjk.oss-cn-zhangjiakou.aliyuncs.com";

/**
 * DingTalk in memory: Stream registration and a socket speaking its JSON
 * frames (callbacks, ping, disconnect, acknowledgements), and REST routes for
 * tokens, AI cards, robot messages, session webhooks, text emotions, media
 * uploads and file downloads. For tests and the plugin's own scenario; never
 * shipped as the adapter.
 */
export class FakeDingTalk {
  readonly clientId = "dingfakeappkey0001";
  readonly clientSecret = "fake-secret";
  readonly corpId = "dingcorp0001";
  readonly botUserId = "$:LWCP_v1:$robot";
  readonly calls: FakeCall[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly posts: FakePost[] = [];
  readonly cards = new Map<string, FakeCard>();
  readonly emotions: { msgId: string; conversation: string; text: string; recalled: boolean }[] = [];
  /** What the adapter answered to each frame, by the frame's messageId. */
  readonly answers = new Map<string, { code: number; data: unknown; at: number }>();
  readonly sentAt = new Map<string, number>();
  readonly files = new Map<string, { bytes: Uint8Array; type: string }>();
  readonly uploads: { type: string; name: string; size: number; mediaId: string }[] = [];
  readonly subscriptions: unknown[] = [];
  /** Ping data the adapter echoed back. */
  readonly pongs: string[] = [];
  /** When set, the app lacks the card permissions. */
  noCards = false;
  /** Session webhooks DingTalk no longer takes, by session. */
  readonly expired = new Set<string>();
  private ids = 1000;
  private tokens = new Set<string>();
  private tickets = new Set<string>();
  private sessions = new Map<string, string>();
  private fail: { match: (c: FakeCall) => boolean; status: number; body: unknown; headers: Record<string, string>; times: number }[] = [];

  get live() { const s = this.sockets.at(-1); return s && s.readyState === 1 ? s : null; }

  net(): Net {
    const fake = this;
    class Socket extends FakeSocket { constructor(url: string) { super(fake, url); } }
    return { fetch: (input, init) => this.fetch(String(input), init), WebSocket: Socket as unknown as typeof WebSocket };
  }

  id(prefix: string) { return `${prefix}${++this.ids}`; }

  /** Answers the next calls `match` picks with `status` and `body`. */
  failNext(match: (c: FakeCall) => boolean, status: number, body: unknown, opts: { headers?: Record<string, string>; times?: number } = {}) {
    this.fail.push({ match, status, body, headers: opts.headers ?? {}, times: opts.times ?? 1 });
  }

  /** Every token handed out so far stops working. */
  expireTokens() { this.tokens.clear(); }

  /** Session webhooks handed out so far stop working, though they have not reached their stated expiry. */
  expireWebhooks() { for (const s of this.sessions.keys()) this.expired.add(s); }

  /** The connection breaks without a word. */
  drop() { this.sockets.at(-1)?.serverClose(1006); }

  /** Sends a frame to the live connection; returns its messageId. */
  push(type: "SYSTEM" | "EVENT" | "CALLBACK", topic: string, data: unknown, messageId = this.id("frame-")) {
    this.sentAt.set(messageId, Date.now());
    this.live?.deliver(JSON.stringify({ specVersion: "1.0", type, headers: { appId: "app-1", connectionId: "conn-1", contentType: "application/json", messageId, time: String(Date.now()), topic },
      data: typeof data === "string" ? data : JSON.stringify(data) }));
    return messageId;
  }

  ping() { return this.push("SYSTEM", "ping", { opaque: this.id("opaque-") }); }
  disconnect() { return this.push("SYSTEM", "disconnect", { reason: "connection is expired" }); }

  /** A person writes to the robot: in a direct chat, or in `group` (an @ unless `mention` is false). */
  message(o: { sender: string; text?: string; group?: string; mention?: boolean; type?: string; content?: Record<string, unknown>; quote?: { msgId: string; senderId?: string; text: string };
    msgId?: string; frameId?: string; webhookTtlMs?: number; nick?: string }) {
    const msgId = o.msgId ?? this.id("msg");
    const session = this.id("sess");
    this.sessions.set(session, o.group ?? `user:${o.sender}`);
    const text = o.type && o.type !== "text" ? {} : { text: { content: o.text ?? "",
      ...(o.quote ? { isReplyMsg: true, repliedMsg: { msgId: o.quote.msgId, msgType: "text", ...(o.quote.senderId ? { senderId: o.quote.senderId } : {}), content: { text: o.quote.text } } } : {}) } };
    const data = {
      conversationId: o.group ?? `cid-dm-${o.sender}`, conversationType: o.group ? "2" : "1", ...(o.group ? { conversationTitle: "Team", isInAtList: o.mention ?? true } : {}),
      chatbotCorpId: this.corpId, chatbotUserId: this.botUserId, robotCode: this.clientId, msgId, createAt: Date.now(),
      senderNick: o.nick ?? o.sender.toUpperCase(), senderStaffId: o.sender, senderId: `$:LWCP_v1:$${o.sender}`, senderCorpId: this.corpId, isAdmin: false,
      sessionWebhook: `https://oapi.dingtalk.com/robot/sendBySession?session=${session}`, sessionWebhookExpiredTime: Date.now() + (o.webhookTtlMs ?? 90 * 60_000),
      msgtype: o.type ?? "text", ...text, ...(o.content ? { content: o.content } : {})
    };
    const frameId = this.push("CALLBACK", "/v1.0/im/bot/messages/get", data, o.frameId);
    return { msgId, frameId, data };
  }

  /** A person presses a button on a card. */
  press(o: { card: string; user: string; action: string; frameId?: string }) {
    const post = this.posts.find(p => p.id === o.card);
    const dm = post?.conversation.startsWith("user:") ?? true;
    return this.push("CALLBACK", "/v1.0/card/instances/callback", {
      outTrackId: o.card, userId: o.user, corpId: this.corpId, userIdType: 1, type: "actionCallback", extension: "{}",
      spaceType: dm ? "IM_ROBOT" : "IM_GROUP", spaceId: dm ? `cid-dm-${o.user}` : post?.conversation ?? "",
      content: JSON.stringify({ cardPrivateData: { actionIds: [o.action], params: {} } })
    }, o.frameId);
  }

  /** What a post shows now: a card's current Markdown, or the message's text. */
  textOf(p: FakePost): string {
    if (!p.card) return p.text;
    const c = this.cards.get(p.card.id)!;
    return c.params.staticMsgContent || c.streamed || c.params.msgContent || "";
  }

  /** The robot's posts in a conversation, oldest first. */
  posted(conversation: string) { return this.posts.filter(p => p.conversation === conversation); }

  /** A card's buttons as its variables hold them. */
  buttonsOf(id: string): { text: string; id: string; request?: boolean }[] {
    return (JSON.parse(this.cards.get(id)?.params.sys_full_json_obj ?? "{}") as { msgButtons?: { text: string; id: string; request?: boolean }[] }).msgButtons ?? [];
  }

  where(method: string, path: RegExp) { return this.calls.filter(c => c.method === method && path.test(c.path)); }

  // ── Stream ───────────────────────────────────────────────────────────

  open(socket: FakeSocket) {
    const ticket = new URL(socket.url).searchParams.get("ticket") ?? "";
    // A ticket opens one connection.
    if (!this.tickets.delete(ticket)) { queueMicrotask(() => socket.serverClose(1008, "ticket invalid")); return; }
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("open", {}));
  }

  receive(_socket: FakeSocket, text: string) {
    const f = JSON.parse(text) as { code: number; headers?: { messageId?: string; topic?: string }; data?: string };
    if (f.headers?.topic === "ping") { this.pongs.push((JSON.parse(f.data ?? "{}") as { opaque?: string }).opaque ?? ""); return; }
    if (f.headers?.messageId) this.answers.set(f.headers.messageId, { code: f.code, data: f.data ? JSON.parse(f.data) as unknown : undefined, at: Date.now() });
  }

  // ── REST ─────────────────────────────────────────────────────────────

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const method = init.method ?? "GET";
    let body: Record<string, unknown> | null = null;
    if (init.body instanceof FormData) {
      body = {};
      for (const [k, v] of init.body.entries()) body[k] = typeof v === "string" ? v : { name: (v as File).name, size: (v as File).size, type: (v as File).type };
    } else if (typeof init.body === "string") body = JSON.parse(init.body) as Record<string, unknown>;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: FakeCall = { method, host: u.host, path: u.pathname, query: u.searchParams, headers, body, at: Date.now() };
    this.calls.push(call);
    const failing = this.fail.find(f => f.times > 0 && f.match(call));
    if (failing) { failing.times--; return json(failing.body, failing.status, failing.headers); }
    const p = u.pathname;

    if (u.host === STORAGE) {
      const f = this.files.get(decodeURIComponent(p.replace(/^\/fake\//, "")));
      if (u.protocol !== "https:") return new Response("plain http", { status: 400 });
      return f ? new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type, "content-length": String(f.bytes.byteLength) } }) : new Response("NoSuchKey", { status: 404 });
    }
    if (u.host === "oapi.dingtalk.com") return this.oapi(p, u.searchParams, body);
    if (u.host !== "api.dingtalk.com") return json({ code: "notFound" }, 404);

    if (p === "/v1.0/oauth2/accessToken") {
      if (body?.appKey !== this.clientId || body?.appSecret !== this.clientSecret) return json({ code: "invalidClientIdOrSecret", message: "无效的clientId或者clientSecret", requestid: "r1" }, 400);
      const token = this.id("tok-");
      this.tokens.add(token);
      return json({ accessToken: token, expireIn: 7200 });
    }
    if (p === "/v1.0/gateway/connections/open") {
      if (body?.clientId !== this.clientId || body?.clientSecret !== this.clientSecret) return json({ code: "invalidClientIdOrSecret", message: "无效的clientId或者clientSecret" }, 400);
      this.subscriptions.push(body.subscriptions);
      const ticket = this.id("ticket-");
      this.tickets.add(ticket);
      return json({ endpoint: "wss://wss-open-connection.dingtalk.com:443/connect", ticket });
    }
    if (!this.tokens.has(headers["x-acs-dingtalk-access-token"] ?? "")) return json({ code: "InvalidAuthentication", message: "不合法的access_token" }, 401);
    const b = body ?? {};

    if (p === "/v1.0/card/instances/createAndDeliver" && method === "POST") {
      if (this.noCards) return json({ code: "Forbidden.AccessDenied.AccessTokenPermissionDenied", message: "没有调用该接口的权限，接口权限申请参考：Card.Instance.Write" }, 403);
      const id = String(b.outTrackId);
      if (this.cards.has(id)) return json({ code: "param.outTrackId.duplicate", message: "outTrackId 已存在" }, 400);
      const space = String(b.openSpaceId);
      const conversation = space.startsWith("dtv1.card//IM_ROBOT.") ? `user:${space.slice("dtv1.card//IM_ROBOT.".length)}` : space.slice("dtv1.card//IM_GROUP.".length);
      const at = (b.imGroupOpenDeliverModel as { atUserIds?: Record<string, string> } | undefined)?.atUserIds;
      const card: FakeCard = { id, template: String(b.cardTemplateId), params: { ...(b.cardData as { cardParamMap: Record<string, string> }).cardParamMap }, streamed: "", finalized: false, ...(at ? { atUserIds: at } : {}) };
      this.cards.set(id, card);
      this.posts.push({ id, conversation, via: "card", kind: "card", text: "", card, ...(at ? { at: Object.keys(at) } : {}) });
      return json({ success: true, result: { outTrackId: id, deliverResults: [{ spaceType: conversation.startsWith("user:") ? "IM_ROBOT" : "IM_GROUP", spaceId: conversation, success: true, carrierId: this.id("carrier-") }] } });
    }
    if (p === "/v1.0/card/instances" && method === "PUT") {
      if (this.noCards) return json({ code: "Forbidden.AccessDenied.AccessTokenPermissionDenied", message: "没有调用该接口的权限" }, 403);
      const card = this.cards.get(String(b.outTrackId));
      if (!card) return json({ code: "cardInstance.notExist", message: "卡片实例不存在" }, 400);
      Object.assign(card.params, (b.cardData as { cardParamMap: Record<string, string> }).cardParamMap);
      if (card.params.msgContent) card.streamed = card.params.msgContent;
      return json({ success: true, result: true });
    }
    if (p === "/v1.0/card/streaming" && method === "PUT") {
      const card = this.cards.get(String(b.outTrackId));
      if (!card) return json({ code: "cardInstance.notExist", message: "卡片实例不存在" }, 400);
      if (b.key !== "msgContent") return json({ code: "invalid.content", message: "card streaming key invalid" }, 400);
      card.streamed = String(b.content);
      if (b.isFinalize) card.finalized = true;
      return json({ success: true, result: true });
    }
    if (p === "/v1.0/robot/oToMessages/batchSend" || p === "/v1.0/robot/groupMessages/send") {
      if (b.robotCode !== this.clientId) return json({ code: "invalidParameter.robotCode.notExsit", message: "机器人不存在" }, 400);
      const key = this.id("pqk-");
      const param = JSON.parse(String(b.msgParam)) as Record<string, unknown>;
      const conversation = p.includes("oToMessages") ? `user:${(b.userIds as string[])[0]}` : String(b.openConversationId);
      this.posts.push({ id: `m${key}`, conversation, via: "api", kind: String(b.msgKey), text: String(param.text ?? param.content ?? ""), param });
      return json(p.includes("oToMessages") ? { processQueryKey: key, invalidStaffIdList: [], flowControlledStaffIdList: [] } : { processQueryKey: key });
    }
    if (p === "/v1.0/robot/messageFiles/download") {
      if (!this.files.has(String(b.downloadCode))) return json({ code: "invalidParameter.robotCode.downloadCode", message: "downloadCode 无效或已过期" }, 400);
      return json({ downloadUrl: `http://${STORAGE}/fake/${encodeURIComponent(String(b.downloadCode))}?Expires=1999999999&OSSAccessKeyId=x&Signature=y` });
    }
    if (p === "/v1.0/robot/emotion/reply" || p === "/v1.0/robot/emotion/recall") {
      const text = String((b.textEmotion as { text?: string } | undefined)?.text);
      if (p.endsWith("reply")) this.emotions.push({ msgId: String(b.openMsgId), conversation: String(b.openConversationId), text, recalled: false });
      else for (const e of this.emotions) if (e.msgId === b.openMsgId && e.text === text) e.recalled = true;
      return json({ success: true, result: true });
    }
    return json({ code: "notFound", message: "404" }, 404);
  }

  private oapi(p: string, query: URLSearchParams, body: Record<string, unknown> | null): Response {
    if (p === "/media/upload") {
      if (!this.tokens.has(query.get("access_token") ?? "")) return json({ errcode: 40014, errmsg: "不合法的access_token" });
      const media = body?.media as { name: string; size: number } | undefined;
      if (!media) return json({ errcode: 40004, errmsg: "不合法的媒体文件类型" });
      const mediaId = `@lA${this.id("media")}`;
      this.uploads.push({ type: String(query.get("type")), name: media.name, size: media.size, mediaId });
      return json({ errcode: 0, errmsg: "ok", type: query.get("type"), media_id: mediaId, created_at: Date.now() });
    }
    if (p === "/robot/sendBySession") {
      const session = query.get("session") ?? "";
      const conversation = this.sessions.get(session);
      if (!conversation || this.expired.has(session)) return json({ errcode: 300001, errmsg: "session不存在或已过期" });
      const b = body ?? {};
      const markdown = b.markdown as { title?: string; text?: string } | undefined;
      const at = (b.at as { atUserIds?: string[] } | undefined)?.atUserIds;
      this.posts.push({ id: this.id("hook-"), conversation, via: "webhook", kind: String(b.msgtype), text: markdown?.text ?? String((b.text as { content?: string } | undefined)?.content ?? ""), ...(at ? { at } : {}) });
      return json({ errcode: 0, errmsg: "ok" });
    }
    return json({ errcode: 404, errmsg: "not found" }, 404);
  }
}

export class FakeSocket {
  readyState = 1;
  private listeners = new Map<string, Listener[]>();
  constructor(private readonly fake: FakeDingTalk, readonly url: string) { fake.open(this); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string }) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  deliver(text: string) { if (this.readyState === 1) this.emit("message", { data: text }); }
  send(data: string) { if (this.readyState === 1) this.fake.receive(this, String(data)); }
  close(code = 1000) { this.serverClose(code); }
  serverClose(code: number, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }
}
