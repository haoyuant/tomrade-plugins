import { randomBytes } from "node:crypto";
import { ImDeliveryError } from "@tomradex/plugin-sdk";

export interface Net {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** The runtime's network, read when a connection opens, so a test can stand in for WeCom. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis), WebSocket: globalThis.WebSocket });

/** The public long-connection address; a private deployment shows its own in the admin console. */
export const SERVER = "wss://openws.work.weixin.qq.com";

/** Every frame either way: a command, the req_id that pairs it with its answer, a body. Answers carry errcode in place of cmd. */
export interface Frame<B = unknown> {
  cmd?: string;
  headers: { req_id: string };
  body?: B;
  errcode?: number;
  errmsg?: string;
}

/** A Bot ID or Secret WeCom does not know, or a bot not set to the long connection: retrying cannot help. */
const REFUSED = new Set([853000, 846601]);
/** WeCom's frequency limits, and its own busy answers. */
const LIMITED = new Set([45009, 45033, 846607, 2400007]);
const BUSY = new Set([-1, 2000111, 2000141]);
/** A callback's req_id that takes no more replies: expired, unknown, or already answered. */
export const STALE = new Set([846604, 846605, 846606]);
/** A streaming reply's ten minutes are up. */
export const STREAM_OVER = 846608;

export class WecomError extends ImDeliveryError {
  constructor(message: string, disposition: "retryable" | "uncertain" | "permanent", readonly code?: number, retryAfterMs?: number) {
    super(message, disposition, retryAfterMs);
  }
}

/** A refusal in WeCom's words. A limit is retryable without a wait, which WeCom never names: the IM layer backs off. */
export const refused = (code: number, msg?: string) =>
  new WecomError(`WeCom refused (${code}${msg ? `: ${msg}` : ""})`, LIMITED.has(code) || BUSY.has(code) ? "retryable" : "permanent", code);

export const reqIdOf = (cmd: string) => `${cmd}_${Date.now()}_${randomBytes(4).toString("hex")}`;

export class ConnectionError extends Error {}

/**
 * The intelligent bot's long connection: open the socket, subscribe with the
 * Bot ID and Secret, ping every thirty seconds (a ping nobody answers drops
 * the socket), and pair each frame sent with WeCom's answer by req_id. Frames
 * sharing a req_id (the replies to one callback) go one at a time, since the
 * answer names nothing else. A drop reconnects with backoff; a refused
 * subscription, or another connection taking the bot over, stops for good.
 */
export class LongConnection {
  private ws: WebSocket | null = null;
  private live = false;
  private subscribing: string | null = null;
  private answers = new Map<string, { resolve(frame: Frame): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private lanes = new Map<string, Promise<void>>();
  private ping: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private first: { resolve(): void; reject(e: Error): void } | null = null;

  constructor(private readonly url: string, private readonly creds: { botId: string; secret: string }, private readonly net: Net, private readonly on: {
    /** A message or event callback. */
    frame(frame: Frame): void;
    state(state: "connecting" | "connected" | "error", detail?: string): void;
  }, private readonly opts: { backoffMs?: number; livenessMs?: number; pingMs?: number; ackMs?: number } = {}) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      this.connect();
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.settle("Connection closed");
    const ws = this.ws;
    this.ws = null;
    this.live = false;
    try { ws?.close(1000); } catch { /* already closed */ }
  }

  /** Sends one frame and resolves with WeCom's answer; a refusal rejects in WeCom's words. */
  request(cmd: string, body: unknown, id = reqIdOf(cmd)): Promise<Frame> {
    const run = (this.lanes.get(id) ?? Promise.resolve()).then(() => this.send(cmd, body, id));
    const lane = run.then(() => {}, () => {});
    this.lanes.set(id, lane);
    void lane.then(() => { if (this.lanes.get(id) === lane) this.lanes.delete(id); });
    return run;
  }

  private send(cmd: string, body: unknown, id: string): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (!this.live || this.ws?.readyState !== 1) { reject(new WecomError("Not connected to WeCom", "retryable")); return; }
      const timer = setTimeout(() => {
        this.answers.delete(id);
        reject(new WecomError("WeCom did not answer in time", "uncertain"));
      }, this.opts.ackMs ?? 10_000);
      this.answers.set(id, { resolve, reject, timer });
      if (!this.write({ cmd, headers: { req_id: id }, ...(body !== undefined ? { body } : {}) })) {
        clearTimeout(timer);
        this.answers.delete(id);
        reject(new WecomError("Not connected to WeCom", "retryable"));
      }
    });
  }

  private write(frame: Frame<unknown>): boolean {
    try {
      if (this.ws?.readyState !== 1) return false;
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch { return false; }
  }

  private clearTimers() {
    for (const t of [this.ping, this.watchdog, this.retry]) if (t) clearTimeout(t);
    this.ping = this.watchdog = this.retry = null;
  }

  /** Frames still waiting for an answer may or may not have reached WeCom. */
  private settle(reason: string) {
    for (const [id, waiting] of this.answers) {
      clearTimeout(waiting.timer);
      waiting.reject(new WecomError(`${reason} before WeCom answered`, "uncertain"));
      this.answers.delete(id);
    }
  }

  private connect() {
    if (this.stopped) return;
    let ws: WebSocket;
    try { ws = new this.net.WebSocket(this.url); } catch (e) { this.closed((e as Error).message); return; }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.subscribing = reqIdOf("aibot_subscribe");
      this.write({ cmd: "aibot_subscribe", headers: { req_id: this.subscribing }, body: { bot_id: this.creds.botId, secret: this.creds.secret } });
      this.watchdog = setTimeout(() => this.drop("no answer to the subscription"), this.opts.ackMs ?? 10_000);
    });
    ws.addEventListener("message", event => {
      if (this.ws !== ws) return;
      const data = event.data as unknown;
      const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : null;
      if (text !== null) this.message(text);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closed("connection closed");
    });
    ws.addEventListener("error", () => { /* a close follows */ });
  }

  private message(text: string) {
    let frame: Frame;
    // WeCom's JSON may carry stray control characters.
    try { frame = JSON.parse(text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")) as Frame; } catch { return; }
    if (this.watchdog && !this.subscribing) { clearTimeout(this.watchdog); this.watchdog = null; }
    const id = frame.headers?.req_id ?? "";
    if (frame.cmd === "aibot_msg_callback" || frame.cmd === "aibot_event_callback") {
      if ((frame.body as { event?: { eventtype?: string } } | undefined)?.event?.eventtype === "disconnected_event") {
        this.fail("Another connection signed in with this bot, and WeCom keeps only one. Stop the other one, then reconnect here.");
        return;
      }
      if (this.live) this.on.frame(frame);
      return;
    }
    if (id && id === this.subscribing) { this.subscribed(frame); return; }
    const waiting = this.answers.get(id);
    // A pong, or an answer that came after its deadline.
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.answers.delete(id);
    if (!frame.errcode) waiting.resolve(frame);
    else waiting.reject(refused(frame.errcode, frame.errmsg));
  }

  private subscribed(frame: Frame) {
    this.subscribing = null;
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    if (!frame.errcode) {
      this.live = true;
      this.attempts = 0;
      this.on.state("connected");
      this.first?.resolve();
      this.first = null;
      this.beat();
      return;
    }
    const message = `WeCom refused the bot (${frame.errcode}${frame.errmsg ? `: ${frame.errmsg}` : ""}). Check the Bot ID and Secret, and that the bot is in API mode with the long connection.`;
    // A refusal on first connecting is told at once; later only one that retrying cannot fix stops reconnecting.
    if (this.first || REFUSED.has(frame.errcode)) this.fail(message);
    else this.drop(message);
  }

  /** Ping now and every thirty seconds; a ping nobody answers means the socket is dead. */
  private beat() {
    this.write({ cmd: "ping", headers: { req_id: reqIdOf("ping") } });
    // Armed by the first unanswered ping; any frame from WeCom disarms it.
    this.watchdog ??= setTimeout(() => this.drop("no answer to ping"), this.opts.livenessMs ?? 20_000);
    this.ping = setTimeout(() => this.beat(), this.opts.pingMs ?? 30_000);
  }

  /** Closes this socket on purpose; `closed` reconnects. */
  private drop(detail: string) {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(4000); } catch { /* already closed */ }
    this.closed(detail);
  }

  private fail(message: string) {
    this.stopped = true;
    this.clearTimers();
    this.settle("Connection stopped");
    this.live = false;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
    if (this.first) { this.first.reject(new ConnectionError(message)); this.first = null; }
    else this.on.state("error", message);
  }

  private closed(detail: string) {
    this.clearTimers();
    this.live = false;
    this.subscribing = null;
    this.settle("Connection lost");
    if (this.stopped) return;
    const base = this.opts.backoffMs ?? 1000;
    const wait = Math.min(30_000, base * 2 ** Math.min(this.attempts++, 5)) + Math.random() * base;
    if (!this.first) this.on.state("connecting", detail);
    this.retry = setTimeout(() => this.connect(), wait);
  }
}
