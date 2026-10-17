import { createCipheriv, randomBytes } from "node:crypto";
import type { Net } from "./gateway.js";

type Body = Record<string, unknown>;
type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;
type Answer = (errcode?: number, errmsg?: string, body?: Body) => void;

/** A message frame the bot sent: a reply on a callback, a push, or a card update. */
export interface FakeFrame { cmd: string; conv: string; reqId: string; body: Body; at: number }
/** What a chat shows, one entry per message: a stream's latest text, a card's latest state. */
export interface FakeShown {
  id: string; conv: string; kind: string; text: string; finished: boolean; frames: number;
  /** A stream's first text, before anything replaced it. */
  first?: string; card?: Body; mediaId?: string;
  /** The message a reply answers, when it went on that message's callback. */
  replyTo?: string;
}

/**
 * WeCom's intelligent-bot long connection in memory: subscription, ping,
 * message and card callbacks, replies and pushes with their answers, card
 * updates, chunked media uploads, and encrypted file downloads. Each chat
 * keeps to WeCom's 30 messages a minute. For tests and the plugin's own
 * scenario; never shipped as the adapter.
 */
export class FakeWecom {
  readonly botId = "aibFakeBot01";
  readonly secret = "fake-secret";
  readonly sockets: FakeSocket[] = [];
  readonly frames: FakeFrame[] = [];
  readonly shown: FakeShown[] = [];
  readonly updates: { eventId: string; body: Body; at: number }[] = [];
  /** When each callback was sent, by msgid, so a test can tell how fast it was answered. */
  readonly sentAt = new Map<string, number>();
  readonly media = new Map<string, { type: string; filename: string; bytes: Uint8Array }>();
  pings = 0;
  /** When set, pings go unanswered, as on a dead connection. */
  silent = false;
  /** How long a callback's req_id takes replies. */
  replyMs = 24 * 3_600_000;
  /** Messages a chat takes a minute before WeCom refuses with 846607. */
  limit = 30;
  private callbacks = new Map<string, { conv: string; at: number; msgid: string; event: boolean }>();
  private downloads = new Map<string, { bytes: Uint8Array; name?: string }>();
  private uploading = new Map<string, { type: string; filename: string; total: number; chunks: Map<number, Uint8Array> }>();
  private fail: { match: (cmd: string, body: Body) => boolean; errcode: number | "silent"; times: number }[] = [];
  private ids = 1000;

  get live() { const s = this.sockets.at(-1); return s && s.readyState === 1 && s.subscribed ? s : null; }

  net(): Net {
    const fake = this;
    class Socket extends FakeSocket { constructor(url: string) { super(fake, url); } }
    return { fetch: input => this.download(String(input)), WebSocket: Socket as unknown as typeof WebSocket };
  }

  id(prefix: string) { return `${prefix}${++this.ids}`; }

  /** Answers the next frames `match` picks with WeCom's `errcode`, or not at all. */
  failNext(match: (cmd: string, body: Body) => boolean, errcode: number | "silent", times = 1) {
    this.fail.push({ match, errcode, times });
  }

  /** The connection breaks; the client should reconnect and subscribe again. */
  drop() { this.sockets.at(-1)?.serverClose(1006); }

  /** Another client takes the bot over: WeCom tells this connection, then closes it. */
  kick() {
    const s = this.sockets.at(-1);
    s?.push({ cmd: "aibot_event_callback", headers: { req_id: this.id("req_") }, body: { msgid: this.id("evt"), create_time: 1, aibotid: this.botId, msgtype: "event", event: { eventtype: "disconnected_event" } } });
    s?.serverClose(1000);
  }

  /** A person writes to the bot: directly, or in a group (`chat`) where the text starts with the bot's @mention. */
  message(o: { from: string; text?: string; chat?: string; type?: string; body?: Body; quote?: Body; msgid?: string }) {
    const msgid = o.msgid ?? this.id("msg");
    const group = !!o.chat;
    const body: Body = {
      msgid, aibotid: this.botId, ...(group ? { chatid: o.chat, chattype: "group" } : { chattype: "single" }), from: { userid: o.from },
      msgtype: o.type ?? "text", ...(o.text !== undefined ? { text: { content: group ? `@Tomrade ${o.text}` : o.text } } : {}), ...o.body,
      ...(o.quote ? { quote: o.quote } : {})
    };
    const reqId = this.callback(body, false);
    return { msgid, reqId, body };
  }

  /** A callback again under a new req_id, as WeCom redelivers one. */
  callback(body: Body, event: boolean): string {
    const reqId = this.id("req_");
    this.callbacks.set(reqId, { conv: String(body.chatid ?? (body.from as { userid: string }).userid), at: Date.now(), msgid: String(body.msgid), event });
    this.sentAt.set(String(body.msgid), Date.now());
    this.live?.push({ cmd: event ? "aibot_event_callback" : "aibot_msg_callback", headers: { req_id: reqId }, body });
    return reqId;
  }

  /** A person presses a card's button (`key` is its key) or submits its choices (`key` "submit"). */
  press(o: { from: string; taskId: string; key: string; chat?: string; selected?: { question_key: string; ids: string[] }[] }) {
    const msgid = this.id("evt");
    const card = this.shown.find(s => s.card?.task_id === o.taskId)?.card;
    this.callback({
      msgid, create_time: 1700000000, aibotid: this.botId, ...(o.chat ? { chatid: o.chat, chattype: "group" } : { chattype: "single" }), from: { userid: o.from },
      msgtype: "event", event: { eventtype: "template_card_event", template_card_event: {
        card_type: card?.card_type ?? "button_interaction", event_key: o.key, task_id: o.taskId,
        ...(o.selected ? { selected_items: { selected_item: o.selected.map(s => ({ question_key: s.question_key, option_ids: { option_id: s.ids } })) } } : {})
      } }
    }, true);
    return msgid;
  }

  /** A file as WeCom serves it from a message: encrypted under its own key, at an address on Tencent Cloud. */
  file(bytes: Uint8Array, name?: string): { url: string; aeskey: string } {
    const key = randomBytes(32);
    const pad = 32 - (bytes.length % 32);
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad, pad)])), cipher.final()]);
    const url = `https://ww-aibot-img-1258476243.cos.ap-guangzhou.myqcloud.com/${this.id("f")}?sign=fake`;
    this.downloads.set(url, { bytes: new Uint8Array(sealed), ...(name ? { name } : {}) });
    return { url, aeskey: key.toString("base64") };
  }

  chat(conv: string) { return this.shown.filter(s => s.conv === conv); }
  said(conv: string, text: string) { return this.chat(conv).some(s => s.text.includes(text) || JSON.stringify(s.card ?? {}).includes(text)); }
  cards(conv: string) { return this.chat(conv).filter(s => s.card).map(s => s.card!); }

  /** Most message frames one chat got within any `ms`. */
  busiest(conv: string, ms = 60_000) {
    const times = this.frames.filter(f => f.conv === conv).map(f => f.at);
    return times.reduce((most, t, i) => Math.max(most, times.slice(i).filter(u => u - t < ms).length), 0);
  }

  // ── Long connection ──────────────────────────────────────────────────

  open(socket: FakeSocket) {
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("open", {}));
  }

  receive(socket: FakeSocket, f: { cmd: string; headers: { req_id: string }; body?: Body }) {
    const answer: Answer = (errcode = 0, errmsg = "ok", body) =>
      queueMicrotask(() => socket.push({ headers: { req_id: f.headers.req_id }, errcode, errmsg, ...(body ? { body } : {}) }));
    const body = f.body ?? {};
    if (f.cmd === "aibot_subscribe") {
      if (body.bot_id !== this.botId || body.secret !== this.secret) { answer(853000, "invalid bot_id or secret"); return; }
      socket.subscribed = true;
      answer();
      return;
    }
    if (!socket.subscribed) { answer(846609, "aibot not subscribed"); return; }
    if (f.cmd === "ping") {
      this.pings++;
      if (!this.silent) answer();
      return;
    }
    const failing = this.fail.find(x => x.times > 0 && x.match(f.cmd, body));
    if (failing) {
      failing.times--;
      if (failing.errcode !== "silent") answer(failing.errcode, "failure");
      return;
    }
    switch (f.cmd) {
      case "aibot_respond_msg": case "aibot_respond_update_msg": {
        const cb = this.callbacks.get(f.headers.req_id);
        if (!cb) { answer(846605, "invalid req_id"); return; }
        if (Date.now() - cb.at > this.replyMs) { answer(846604, "req_id expired"); return; }
        if (f.cmd === "aibot_respond_msg") { this.show(f.cmd, cb.conv, f.headers.req_id, body, cb.event ? undefined : cb.msgid, answer); return; }
        const card = body.template_card as Body;
        const shown = this.shown.find(s => s.card?.task_id === card.task_id);
        if (!cb.event || !shown) { answer(42016, "task_id not found"); return; }
        shown.card = card;
        this.updates.push({ eventId: cb.msgid, body, at: Date.now() });
        this.frames.push({ cmd: f.cmd, conv: cb.conv, reqId: f.headers.req_id, body, at: Date.now() });
        answer();
        return;
      }
      case "aibot_send_msg":
        this.show(f.cmd, String(body.chatid ?? ""), f.headers.req_id, body, undefined, answer);
        return;
      case "aibot_upload_media_init": {
        const id = this.id("up");
        this.uploading.set(id, { type: String(body.type), filename: String(body.filename), total: Number(body.total_chunks), chunks: new Map() });
        answer(0, "ok", { upload_id: id });
        return;
      }
      case "aibot_upload_media_chunk": {
        const u = this.uploading.get(String(body.upload_id));
        if (!u) { answer(846611, "invalid upload_id"); return; }
        u.chunks.set(Number(body.chunk_index), Buffer.from(String(body.base64_data), "base64"));
        answer();
        return;
      }
      case "aibot_upload_media_finish": {
        const u = this.uploading.get(String(body.upload_id));
        const parts = u ? Array.from({ length: u.total }, (_, i) => u.chunks.get(i)) : [];
        if (!u || parts.some(p => !p)) { answer(846611, "upload incomplete"); return; }
        const mediaId = this.id("media");
        this.media.set(mediaId, { type: u.type, filename: u.filename, bytes: new Uint8Array(Buffer.concat(parts as Uint8Array[])) });
        answer(0, "ok", { type: u.type, media_id: mediaId, created_at: "1380000000" });
        return;
      }
    }
    answer(40008, "invalid cmd");
  }

  private show(cmd: string, conv: string, reqId: string, body: Body, replyTo: string | undefined, answer: Answer) {
    if (this.frames.filter(f => f.conv === conv && f.cmd !== "aibot_respond_update_msg" && Date.now() - f.at < 60_000).length >= this.limit) { answer(846607, "message limit"); return; }
    const msgtype = String(body.msgtype);
    if (msgtype === "stream") {
      const st = body.stream as { id: string; finish?: boolean; content?: string };
      let s = this.shown.find(x => x.kind === "stream" && x.id === st.id);
      if (s?.finished) { answer(846608, "stream already finished"); return; }
      if (!s) {
        s = { id: st.id, conv, kind: "stream", text: "", finished: false, frames: 0, first: st.content ?? "", ...(replyTo ? { replyTo } : {}) };
        this.shown.push(s);
      }
      s.text = st.content ?? "";
      s.finished = !!st.finish;
      s.frames++;
    } else {
      const media = body[msgtype] as { media_id?: string } | undefined;
      this.shown.push({ id: this.id("om"), conv, kind: msgtype, text: msgtype === "markdown" ? String((body.markdown as Body).content) : "", finished: true, frames: 1,
        ...(msgtype === "template_card" ? { card: body.template_card as Body } : {}), ...(media?.media_id ? { mediaId: media.media_id } : {}), ...(replyTo ? { replyTo } : {}) });
    }
    this.frames.push({ cmd, conv, reqId, body, at: Date.now() });
    answer();
  }

  // ── Downloads ────────────────────────────────────────────────────────

  private async download(url: string): Promise<Response> {
    const d = this.downloads.get(url);
    if (!d) return new Response("not found", { status: 404 });
    return new Response(new Uint8Array(d.bytes), { headers: { "content-type": "application/octet-stream", "content-length": String(d.bytes.byteLength),
      ...(d.name ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}` } : {}) } });
  }
}

export class FakeSocket {
  readyState = 1;
  subscribed = false;
  private listeners = new Map<string, Listener[]>();
  constructor(private readonly fake: FakeWecom, readonly url: string) { fake.open(this); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string }) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  push(frame: unknown) { if (this.readyState === 1) this.emit("message", { data: JSON.stringify(frame) }); }
  send(data: string) { if (this.readyState === 1) this.fake.receive(this, JSON.parse(data) as { cmd: string; headers: { req_id: string }; body?: Body }); }
  close(code = 1000) { this.serverClose(code); }
  serverClose(code: number, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }
}
