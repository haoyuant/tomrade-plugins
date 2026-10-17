import { type Api, type Net, SlackError } from "./api.js";

export class ConnectionError extends Error {}

/** One Socket Mode message: an envelope to acknowledge, or Slack's own `hello` and `disconnect`. */
export interface Envelope {
  type: string;
  envelope_id?: string;
  payload?: unknown;
  accepts_response_payload?: boolean;
  retry_attempt?: number;
  retry_reason?: string;
  reason?: string;
}

/**
 * Slack's Socket Mode: ask apps.connections.open for an address with the
 * app-level token, wait for `hello`, and acknowledge every envelope the
 * moment it arrives — the handler only queues work, so a button or a command
 * is answered inside Slack's three seconds. A `disconnect`, or a socket that
 * has heard nothing for a while, brings up a fresh connection before the old
 * one is let go; a drop reconnects with backoff. Slack redelivers what went
 * unacknowledged and the IM layer keeps each event once.
 */
export class SocketMode {
  private live: WebSocket | null = null;
  private next: WebSocket | null = null;
  private opening = false;
  private seen = Date.now();
  private watch: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;
  private first: { resolve(): void; reject(e: Error): void } | null = null;

  constructor(private readonly api: Api, private readonly net: Net, private readonly on: {
    /** One envelope; the return value, if any, is the payload of its acknowledgement (a slash command's reply). */
    envelope(envelope: Envelope): unknown;
    state(state: "connecting" | "connected" | "error", detail?: string): void;
  }, private readonly opts: { backoffMs?: number; idleMs?: number } = {}) {}

  /** Resolves on the first `hello`; rejects only when Slack refuses the app outright. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      void this.connect();
    });
  }

  stop() {
    this.stopped = true;
    if (this.watch) clearInterval(this.watch);
    if (this.retry) clearTimeout(this.retry);
    this.watch = this.retry = null;
    const sockets = [this.live, this.next];
    this.live = this.next = null;
    for (const ws of sockets) try { ws?.close(1000); } catch { /* already closed */ }
  }

  private async connect() {
    if (this.stopped || this.opening) return;
    this.opening = true;
    let url: string;
    try {
      url = (await this.api.call<{ url: string }>("apps.connections.open", {}, { repeatable: true })).url;
    } catch (e) {
      this.opening = false;
      if (e instanceof SlackError && e.disposition === "permanent") {
        this.fail(`Slack refused the App-Level Token (${e.code ?? e.message}). It starts with xapp-, needs the connections:write scope, and the app needs Socket Mode on.`);
      } else this.closed((e as Error).message, e instanceof SlackError ? e.retryAfterMs : undefined);
      return;
    }
    if (this.stopped) { this.opening = false; return; }
    const ws = new this.net.WebSocket(url);
    this.next = ws;
    ws.addEventListener("message", event => this.message(ws, event.data));
    ws.addEventListener("close", () => this.gone(ws));
    ws.addEventListener("error", () => { /* a close follows */ });
  }

  private message(ws: WebSocket, data: unknown) {
    if (ws !== this.live && ws !== this.next) return;
    let msg: Envelope;
    try { msg = JSON.parse(String(data)) as Envelope; } catch { return; }
    if (ws === this.live) this.seen = Date.now();
    if (msg.type === "hello") {
      if (ws !== this.next) return;
      const old = this.live;
      this.live = ws;
      this.next = null;
      this.opening = false;
      this.attempts = 0;
      this.seen = Date.now();
      try { old?.close(1000); } catch { /* already closed */ }
      this.on.state("connected");
      this.first?.resolve();
      this.first = null;
      const idle = this.opts.idleMs ?? 300_000;
      this.watch ??= setInterval(() => this.check(), Math.min(15_000, Math.max(5, idle / 2)));
      return;
    }
    if (msg.type === "disconnect") {
      // Socket Mode was switched off in the app's settings; reconnecting cannot help.
      if (msg.reason === "link_disabled") this.fail("Socket Mode was turned off for this Slack app");
      else if (ws === this.live) void this.connect();
      return;
    }
    if (!msg.envelope_id) return;
    let payload: unknown;
    try { payload = this.on.envelope(msg); } catch { /* acknowledged all the same, so Slack does not send it again */ }
    try { ws.send(JSON.stringify({ envelope_id: msg.envelope_id, ...(payload !== undefined ? { payload } : {}) })); } catch { /* the socket is closing */ }
  }

  private gone(ws: WebSocket) {
    if (ws === this.next) {
      this.next = null;
      this.opening = false;
      this.closed("connection closed");
    } else if (ws === this.live) {
      this.live = null;
      if (!this.opening) this.closed("connection closed");
      else if (!this.first) this.on.state("connecting", "connection closed");
    }
  }

  /** A socket can die without a close (a sleep, a changed network) and Slack says nothing while idle, so a quiet one is replaced. */
  private check() {
    if (this.stopped || this.opening || !this.live) return;
    if (Date.now() - this.seen > (this.opts.idleMs ?? 300_000)) void this.connect();
  }

  private fail(message: string) {
    this.stop();
    if (this.first) { this.first.reject(new ConnectionError(message)); this.first = null; }
    else this.on.state("error", message);
  }

  /** Tries again after a backoff; says so only when no socket is left. */
  private closed(detail: string, retryAfterMs?: number) {
    if (this.stopped) return;
    if (this.retry) clearTimeout(this.retry);
    const base = this.opts.backoffMs ?? 1000;
    const wait = Math.max(retryAfterMs ?? 0, Math.min(30_000, base * 2 ** Math.min(this.attempts++, 5)) + Math.random() * base);
    if (!this.live && !this.first) this.on.state("connecting", detail);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, wait);
  }
}
