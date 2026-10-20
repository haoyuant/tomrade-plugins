import { ImDeliveryError } from "@tomradex/plugin-sdk";

export interface Net { fetch: typeof fetch }

/** The runtime's network, read when a connection opens, so a test can stand in for Telegram. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis) });

export const BASE = "https://api.telegram.org";

export class TelegramError extends ImDeliveryError {
  constructor(message: string, disposition: "retryable" | "uncertain" | "permanent", readonly code?: number, readonly description = "", retryAfterMs?: number) {
    super(message, disposition, retryAfterMs);
  }
}

/** Failures before a request reached Telegram, so nothing was sent. */
const UNSENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const causeOf = (e: unknown) => String((e as { cause?: { code?: unknown } } | null)?.cause?.code ?? (e as { code?: unknown } | null)?.code ?? "");

type Answer<T> = { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };

/**
 * The Bot API. Edits, reactions and reads are idempotent, so a lost answer is
 * safe to retry. A new message is not: Telegram has no key that drops a second
 * copy, so a send whose answer was lost is uncertain. The token is only ever
 * part of the address, never of an error.
 */
export class Api {
  constructor(private readonly token: string, private readonly n: Net, readonly base = BASE) {}

  async call<T = true>(method: string, params: Record<string, unknown> | FormData = {}, opts: { idempotent?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const form = params instanceof FormData;
    let res: Response;
    try {
      res = await this.n.fetch(`${this.base}/bot${this.token}/${method}`, {
        method: "POST", ...(form ? {} : { headers: { "content-type": "application/json" } }),
        body: form ? params : JSON.stringify(params), ...(opts.signal ? { signal: opts.signal } : {})
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new TelegramError(`Telegram unreachable: ${(e as Error).message}`, opts.idempotent || UNSENT.has(causeOf(e)) ? "retryable" : "uncertain");
    }
    const answer = await res.json().catch(() => null) as Answer<T> | null;
    if (answer?.ok) return answer.result as T;
    const code = answer?.error_code ?? res.status;
    const description = answer?.description ?? `HTTP ${res.status}`;
    if (code === 429) throw new TelegramError("Telegram rate limit", "retryable", code, description, Math.max(1, answer?.parameters?.retry_after ?? 1) * 1000);
    if (code >= 500) throw new TelegramError(`Telegram error ${code}`, opts.idempotent ? "retryable" : "uncertain", code, description);
    throw new TelegramError(`Telegram refused ${method} (${code}: ${description})`, "permanent", code, description);
  }

  /** A file's bytes, through the path getFile names; a bot may fetch up to 20 MB. */
  async download(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId }, { idempotent: true });
    if (!file.file_path) throw new TelegramError("Telegram gave no path for the file", "permanent");
    let res: Response;
    try { res = await this.n.fetch(`${this.base}/file/bot${this.token}/${file.file_path}`); }
    catch (e) { throw new TelegramError(`Telegram unreachable: ${(e as Error).message}`, "retryable"); }
    if (!res.ok) throw new TelegramError(`File download failed (${res.status})`, res.status >= 500 ? "retryable" : "permanent", res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Telegram could not read the HTML; the same words can still go as plain text. */
export const unparsable = (e: unknown) => e instanceof TelegramError && e.disposition === "permanent" && /can't parse entities|unsupported start tag|end tag|unsupported url/i.test(e.description);
/** An edit that changes nothing, which Telegram refuses; for this adapter it is done. */
export const unchanged = (e: unknown) => e instanceof TelegramError && /message is not modified/i.test(e.description);
/** A topic already named so, or already closed or open, which Telegram refuses; for this adapter it is done. */
export const untouched = (e: unknown) => e instanceof TelegramError && e.disposition === "permanent" && /TOPIC_NOT_MODIFIED|not modified|already (closed|open)/i.test(e.description);
