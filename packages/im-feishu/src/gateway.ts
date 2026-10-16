import { type Api, FeishuError, type Net } from "./api.js";
import { decodeFrame, encodeFrame, type Frame, FrameMethod, header } from "./proto.js";

/** Endpoint codes Feishu may answer while it is busy; anything else means the app cannot connect. */
const BUSY = new Set([1, 1000040343]);

export class ConnectionError extends Error {}

/**
 * Feishu's long connection: ask the endpoint for a socket address, open it,
 * ping on the interval Feishu sets, and acknowledge every event — with the
 * handler's answer, which is how a card callback gets its reply within the
 * three seconds Feishu waits. A drop asks for a fresh address and reconnects
 * with backoff; Feishu redelivers what went unacknowledged and the IM layer
 * keeps each event once.
 */
export class LongConnection {
  private ws: WebSocket | null = null;
  private service = 0;
  private pingMs = 120_000;
  private ping: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private first: { resolve(): void; reject(e: Error): void } | null = null;
  /** Events larger than one frame arrive in parts. */
  private parts = new Map<string, { chunks: (Uint8Array | undefined)[]; at: number }>();

  constructor(private readonly api: Api, private readonly net: Net, private readonly on: {
    /** One event; the return value, if any, is the answer Feishu passes back (a card callback's). */
    event(payload: Record<string, unknown>): unknown;
    state(state: "connecting" | "connected" | "error", detail?: string): void;
  }, private readonly opts: { backoffMs?: number; livenessMs?: number } = {}) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      void this.connect();
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
  }

  private clearTimers() {
    for (const t of [this.ping, this.watchdog, this.retry]) if (t) clearTimeout(t);
    this.ping = this.watchdog = this.retry = null;
  }

  private async connect() {
    if (this.stopped) return;
    let url: string;
    try {
      const res = await this.api.endpoint();
      const body = await res.json().catch(() => ({})) as { code?: number; msg?: string; data?: { URL?: string; ClientConfig?: { PingInterval?: number } } };
      if (body.code !== 0 || !body.data?.URL) {
        if (res.status < 500 && body.code !== undefined && !BUSY.has(body.code)) {
          this.fail(`Feishu refused the long connection (${body.code}${body.msg ? `: ${body.msg}` : ""}). Check the App ID and App Secret, and that events use the long connection.`);
          return;
        }
        throw new Error(body.msg || `endpoint answered ${res.status}`);
      }
      url = body.data.URL;
      if (body.data.ClientConfig?.PingInterval) this.pingMs = body.data.ClientConfig.PingInterval * 1000;
      this.service = Number(new URL(url).searchParams.get("service_id") ?? 0);
    } catch (e) {
      this.closed(e instanceof FeishuError || e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.stopped) return;
    const ws = new this.net.WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.on.state("connected");
      this.first?.resolve();
      this.first = null;
      this.beat();
    });
    ws.addEventListener("message", event => {
      if (this.ws !== ws) return;
      const data = event.data as unknown;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
      if (!bytes) return;
      if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
      let frame: Frame;
      try { frame = decodeFrame(bytes); } catch { return; }
      if (frame.method === FrameMethod.control) this.control(frame);
      else if (frame.method === FrameMethod.data) this.data(frame);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.closed("connection closed");
    });
    ws.addEventListener("error", () => { /* a close follows */ });
  }

  private send(frame: Frame) {
    if (this.ws?.readyState === 1) this.ws.send(encodeFrame(frame));
  }

  /** Ping now and on Feishu's interval; a ping nobody answers means the socket is dead. */
  private beat() {
    this.send({ SeqID: 0n, LogID: 0n, service: this.service, method: FrameMethod.control, headers: [{ key: "type", value: "ping" }] });
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.drop(), this.opts.livenessMs ?? 30_000);
    this.ping = setTimeout(() => this.beat(), this.pingMs);
  }

  private control(frame: Frame) {
    if (header(frame, "type") !== "pong" || !frame.payload?.length) return;
    try {
      const config = JSON.parse(new TextDecoder().decode(frame.payload)) as { PingInterval?: number };
      if (config.PingInterval) this.pingMs = config.PingInterval * 1000;
    } catch { /* a pong without config still proves the socket */ }
  }

  private data(frame: Frame) {
    const type = header(frame, "type");
    if (type !== "event" && type !== "card") return;
    const id = header(frame, "message_id") ?? "";
    const sum = Number(header(frame, "sum") ?? 1);
    const seq = Number(header(frame, "seq") ?? 0);
    let payload = frame.payload ?? new Uint8Array();
    if (sum > 1) {
      const now = Date.now();
      for (const [k, v] of this.parts) if (now - v.at > 60_000) this.parts.delete(k);
      const entry = this.parts.get(id) ?? { chunks: new Array<Uint8Array | undefined>(sum).fill(undefined), at: now };
      entry.chunks[seq] = payload;
      this.parts.set(id, entry);
      if (entry.chunks.some(c => !c)) return;
      this.parts.delete(id);
      payload = new Uint8Array(entry.chunks.reduce((n, c) => n + c!.length, 0));
      let at = 0;
      for (const c of entry.chunks) { payload.set(c!, at); at += c!.length; }
    }
    const started = Date.now();
    let answer: { code: number; data?: string } = { code: 200 };
    try {
      const result = this.on.event(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
      if (result !== undefined) answer = { code: 200, data: Buffer.from(JSON.stringify(result)).toString("base64") };
    } catch { answer = { code: 500 }; }
    this.send({ ...frame, headers: [...frame.headers, { key: "biz_rt", value: String(Date.now() - started) }], payload: new TextEncoder().encode(JSON.stringify(answer)) });
  }

  /** Closes this socket on purpose; `closed` reconnects. */
  private drop() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(4000); } catch { /* already closed */ }
    this.closed("no answer to ping");
  }

  private fail(message: string) {
    this.stopped = true;
    this.clearTimers();
    if (this.first) { this.first.reject(new ConnectionError(message)); this.first = null; }
    else this.on.state("error", message);
  }

  private closed(detail: string) {
    this.clearTimers();
    if (this.stopped) return;
    const base = this.opts.backoffMs ?? 1000;
    const wait = Math.min(30_000, base * 2 ** Math.min(this.attempts++, 5)) + Math.random() * base;
    if (!this.first) this.on.state("connecting", detail);
    this.retry = setTimeout(() => void this.connect(), wait);
  }
}
