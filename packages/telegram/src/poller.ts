import { type Api, TelegramError } from "./api.js";
import type { TUpdate } from "./wire.js";

/** What the adapter reads; Telegram keeps nothing else for it. */
export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query"];

/** Refusals no retry fixes: a revoked token, or a webhook that holds the bot's updates. */
export function fatal(e: unknown): string | null {
  if (!(e instanceof TelegramError)) return null;
  if (e.code === 401 || e.code === 404) return `Telegram refused the bot token (${e.description}). Copy it again from @BotFather.`;
  if (e.code === 409 && /webhook/i.test(e.description)) return "This bot hands its updates to a webhook, so Telegram gives none to Tomrade. Use a bot made for Tomrade, or remove the webhook.";
  return null;
}

/**
 * getUpdates long polling. Each update goes to the adapter, and only once that
 * resolves (the IM layer has stored it) does the offset move past it; Telegram
 * drops what an offset passed and keeps the rest for 24 hours, so whatever was
 * not taken comes back after a restart. A failed poll is retried with backoff;
 * a webhook or a revoked token stops polling.
 */
export class Poller {
  private offset: number | undefined;
  /** The last offset Telegram saw, up to which it has dropped updates. */
  private confirmed: number | undefined;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;
  private attempts = 0;
  private failing = false;

  constructor(private readonly api: Api, private readonly on: {
    /** Resolves once the update was handed over; never rejects. */
    update(u: TUpdate): Promise<void>;
    state(state: "connecting" | "connected" | "error", detail?: string): void;
  }, private readonly opts: { timeoutS?: number; backoffMs?: number } = {}) {}

  start() { void this.loop(); }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    // Tells Telegram what was taken, so the next start does not fetch it again; the IM layer would keep it once regardless.
    if (this.offset !== undefined && this.offset !== this.confirmed) void this.api.call("getUpdates", { offset: this.offset, limit: 1, timeout: 0 }, { idempotent: true }).catch(() => {});
  }

  private async poll(timeout: number) {
    const controller = new AbortController();
    this.controller = controller;
    // A poll held open longer than Telegram promised is a dead connection.
    const limit = setTimeout(() => controller.abort(), (timeout + 15) * 1000);
    const offset = this.offset;
    let updates: TUpdate[];
    try {
      updates = await this.api.call<TUpdate[]>("getUpdates", { ...(offset !== undefined ? { offset } : {}), timeout, allowed_updates: ALLOWED_UPDATES },
        { idempotent: true, signal: controller.signal });
    } finally { clearTimeout(limit); }
    if (offset !== undefined) this.confirmed = offset;
    for (const u of updates) {
      if (this.stopped) return;
      await this.on.update(u).catch(() => {});
      // Closed while it was being handed over: it stays unconfirmed and comes back next time.
      if (this.stopped) return;
      this.offset = u.update_id + 1;
    }
  }

  private async loop() {
    while (!this.stopped) {
      try {
        // After a failure a short poll proves the way is open again before the next long wait.
        await this.poll(this.failing ? 0 : this.opts.timeoutS ?? 25);
        this.attempts = 0;
        if (this.failing) { this.failing = false; this.on.state("connected"); }
      } catch (e) {
        if (this.stopped) return;
        const why = fatal(e);
        if (why) { this.stopped = true; this.on.state("error", why); return; }
        const conflict = e instanceof TelegramError && e.code === 409;
        // Another getUpdates ended this one, often this computer's previous connection settling; only a lasting conflict is news.
        if ((!conflict || this.attempts > 0) && !this.failing) {
          this.failing = true;
          this.on.state("connecting", conflict ? "Another program is reading this bot's updates" : e instanceof Error ? e.message : String(e));
        }
        const base = this.opts.backoffMs ?? 1000;
        const wait = e instanceof TelegramError && e.retryAfterMs ? e.retryAfterMs : Math.min(30_000, base * 2 ** Math.min(this.attempts, 5)) + Math.random() * base;
        this.attempts++;
        await new Promise<void>(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, wait); });
        this.wake = null;
      }
    }
  }
}
