import type { Api, Net } from "./api.js";
import { Recent } from "./wire.js";

/** What the connection subscribes to: robot messages, and the buttons pressed on its cards. */
export const TOPIC = { message: "/v1.0/im/bot/messages/get", card: "/v1.0/card/instances/callback" } as const;
const SUBSCRIPTIONS = [{ type: "CALLBACK", topic: TOPIC.message }, { type: "CALLBACK", topic: TOPIC.card }];

/** One Stream frame: SYSTEM (ping, disconnect), EVENT or CALLBACK, with its payload as a JSON string. */
export interface Frame { specVersion?: string; type?: string; headers?: { topic?: string; messageId?: string; [key: string]: unknown }; data?: string }

export class ConnectionError extends Error {}

/**
 * DingTalk's Stream mode: register for a socket address and a ticket good
 * for one connection, open it, and answer every frame — a ping with its own
 * data, a callback with the handler's response, which is how a card button
 * is acknowledged inside DingTalk's three seconds. A disconnect notice or a
 * socket gone quiet brings a fresh connection up before the old one closes;
 * a drop reconnects with backoff. A redelivered callback is answered again
 * and handled once.
 */
export class StreamConnection {
  private ws: WebSocket | null = null;
  private opening = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private first: { resolve(): void; reject(e: Error): void } | null = null;
  private answered = new Recent<unknown>(1000);

  constructor(private readonly api: Api, private readonly net: Net, private readonly on: {
    /** One callback; the return value is the response DingTalk passes back (a card button's). */
    callback(topic: string, data: unknown, messageId: string): unknown;
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
    for (const t of [this.watchdog, this.retry]) if (t) clearTimeout(t);
    this.watchdog = this.retry = null;
  }

  private async connect() {
    if (this.stopped || this.opening) return;
    this.opening = true;
    let url: string;
    try {
      const res = await this.api.openConnection(SUBSCRIPTIONS);
      const body = await res.json().catch(() => ({})) as { endpoint?: string; ticket?: string; code?: string; message?: string };
      if (!res.ok || !body.endpoint || !body.ticket) {
        if (res.status < 500 && res.status !== 429) {
          this.opening = false;
          this.fail(`DingTalk refused the Stream connection (${body.code ?? res.status}${body.message ? `: ${body.message}` : ""}). Check the Client ID and Client Secret.`);
          return;
        }
        throw new Error(body.message || `connections/open answered ${res.status}`);
      }
      url = `${body.endpoint}?ticket=${encodeURIComponent(body.ticket)}`;
    } catch (e) {
      this.opening = false;
      this.lost((e as Error).message);
      return;
    }
    if (this.stopped) { this.opening = false; return; }
    const ws = new this.net.WebSocket(url);
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.opening = false;
      if (this.stopped) { try { ws.close(1000); } catch { /* already closed */ } return; }
      // The socket this one replaces hears nothing more: DingTalk said goodbye to it, or it went quiet.
      const old = this.ws;
      this.ws = ws;
      try { old?.close(1000); } catch { /* already closed */ }
      this.attempts = 0;
      if (!old) this.on.state("connected");
      this.first?.resolve();
      this.first = null;
      this.alive();
    });
    ws.addEventListener("message", event => this.frame(ws, (event as MessageEvent).data));
    ws.addEventListener("close", () => {
      if (!opened) { this.opening = false; if (!this.stopped) this.lost("the socket did not open"); return; }
      if (this.ws !== ws) return;
      this.ws = null;
      this.lost("connection closed");
    });
    ws.addEventListener("error", () => { /* a close follows */ });
  }

  private frame(ws: WebSocket, data: unknown) {
    if (typeof data !== "string") return;
    let f: Frame;
    try { f = JSON.parse(data) as Frame; } catch { return; }
    if (ws === this.ws) this.alive();
    const headers = f.headers ?? {};
    const reply = (code: number, payload: string | undefined, h: Frame["headers"] = { contentType: "application/json", messageId: headers.messageId }) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ code, headers: h, message: code === 200 ? "OK" : "error", data: payload }));
    };
    if (f.type === "SYSTEM") {
      if (headers.topic === "ping") reply(200, f.data, headers);
      else if (headers.topic === "disconnect" && ws === this.ws) this.refresh();
      return;
    }
    if (f.type === "EVENT") { reply(200, JSON.stringify({ status: "SUCCESS" })); return; }
    if (f.type !== "CALLBACK") return;
    const id = headers.messageId ?? "";
    let code = 200;
    let response: unknown = null;
    if (id && this.answered.has(id)) response = this.answered.get(id);
    else {
      try {
        response = this.on.callback(headers.topic ?? "", f.data ? JSON.parse(f.data) as unknown : {}, id) ?? null;
        if (id) this.answered.set(id, response);
      } catch { code = 500; }
    }
    reply(code, JSON.stringify({ response }));
  }

  /**
   * A browser socket cannot ping, so a socket that hears nothing for a while
   * is replaced; on a healthy one that only costs a new ticket.
   */
  private alive() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.refresh(), this.opts.livenessMs ?? 180_000);
  }

  /** A new connection first; the current one closes once it is up. */
  private refresh() {
    if (this.stopped || this.opening) return;
    this.alive();
    void this.connect();
  }

  private fail(message: string) {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
    if (this.first) { this.first.reject(new ConnectionError(message)); this.first = null; }
    else this.on.state("error", message);
  }

  /** The connection is gone, or its replacement could not be made: drop what is left and reconnect after a while. */
  private lost(detail: string) {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
    this.clearTimers();
    if (this.stopped) return;
    const base = this.opts.backoffMs ?? 1000;
    const wait = Math.min(30_000, base * 2 ** Math.min(this.attempts++, 5)) + Math.random() * base;
    if (!this.first) this.on.state("connecting", detail);
    this.retry = setTimeout(() => void this.connect(), wait);
  }
}
