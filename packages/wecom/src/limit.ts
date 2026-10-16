/** One sliding window: `n` frames per `ms`, of which `reserve` are kept for what must not wait. */
export interface Window { n: number; ms: number; reserve: number }

/**
 * What a bot may send one conversation, replies and pushes alike: 30 a minute
 * and 1000 an hour. Stream refreshes and thinking placeholders leave the
 * reserve free, so a final answer, a question card or a receipt still fits.
 */
export const CONVERSATION: Window[] = [{ n: 30, ms: 60_000, reserve: 5 }, { n: 1000, ms: 3_600_000, reserve: 50 }];
/** Media uploads, counted per bot. */
export const UPLOADS: Window[] = [{ n: 30, ms: 60_000, reserve: 0 }, { n: 1000, ms: 3_600_000, reserve: 0 }];

/** Frames sent per key, kept as long as the widest window. */
export class Budget {
  private sent = new Map<string, number[]>();
  private readonly longest: number;

  constructor(private readonly windows: Window[], private readonly now: () => number = Date.now) {
    this.longest = Math.max(...windows.map(w => w.ms));
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.sent.get(key) ?? []).filter(t => now - t < this.longest);
    if (kept.length) this.sent.set(key, kept); else this.sent.delete(key);
    return kept;
  }

  /** Milliseconds until `count` more frames fit, leaving each window's reserve free when `spare`; 0 when they fit now. */
  wait(key: string, count = 1, spare = false): number {
    const now = this.now();
    const times = this.recent(key, now);
    let wait = 0;
    for (const w of this.windows) {
      const inside = times.filter(t => now - t < w.ms);
      const over = inside.length + count + (spare ? w.reserve : 0) - w.n;
      if (over <= 0) continue;
      // The window frees a slot as each of its oldest frames ages out.
      wait = Math.max(wait, over > inside.length ? w.ms : inside[over - 1]! + w.ms - now);
    }
    return wait;
  }

  take(key: string, count = 1) {
    const times = this.recent(key, this.now());
    for (let i = 0; i < count; i++) times.push(this.now());
    this.sent.set(key, times);
  }
}
