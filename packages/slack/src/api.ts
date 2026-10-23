import { ImDeliveryError } from "@tomradex/plugin-sdk";

export interface Net {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** The runtime's network, read when a connection opens, so a test can stand in for Slack. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis), WebSocket: globalThis.WebSocket });

export const API = "https://slack.com/api";

/** The token itself stopped working: nothing the adapter sends will go through. */
export const AUTH_LOST = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
/** Failures before a request left this computer, so it was never seen. */
const UNSENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

const causeOf = (e: unknown) => String((e as { cause?: { code?: unknown } } | null)?.cause?.code ?? "");

export class SlackError extends ImDeliveryError {
  /** `needed`: the scope Slack named for a missing_scope. */
  constructor(message: string, disposition: "retryable" | "uncertain" | "permanent", readonly code?: string, retryAfterMs?: number, readonly needed?: string) {
    super(message, disposition, retryAfterMs);
  }
}

type Args = Record<string, unknown>;

/**
 * Slack's Web API with one token. Arguments go form-encoded, objects as JSON,
 * which every method takes. Slack has no idempotency key for posting, so a
 * post whose answer was lost is uncertain; updates, reactions and statuses
 * are `repeatable` and simply sent again.
 */
export class Api {
  constructor(private readonly token: string, private readonly n: Net, private readonly onAuthLost?: (code: string) => void) {}

  async call<T = Args>(method: string, args: Args = {}, opts: { repeatable?: boolean } = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const unknown = opts.repeatable ? "retryable" : "uncertain";
    let res: Response;
    try {
      res = await this.n.fetch(`${API}/${method}`, {
        method: "POST", body,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
      });
    } catch (e) { throw new SlackError(`Slack unreachable: ${(e as Error).message}`, UNSENT.has(causeOf(e)) ? "retryable" : unknown); }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      throw new SlackError("Slack rate limit", "retryable", "ratelimited", (Number.isFinite(wait) && wait > 0 ? wait : 1) * 1000);
    }
    const answer = await res.json().catch(() => null) as (Args & { ok?: boolean; error?: string; needed?: string }) | null;
    if (res.ok && answer?.ok) return answer as T;
    const code = answer?.error;
    if (res.status >= 500 || code === "internal_error" || code === "fatal_error") throw new SlackError(`Slack error (${code ?? res.status})`, unknown, code);
    if (code === "ratelimited" || code === "service_unavailable" || code === "request_timeout") throw new SlackError(`Slack is busy (${code})`, "retryable", code, 1000);
    if (code && AUTH_LOST.has(code)) this.onAuthLost?.(code);
    throw new SlackError(`Slack refused ${method} (${code ?? res.status})`, "permanent", code, undefined, typeof answer?.needed === "string" ? answer.needed : undefined);
  }

  /** A file's private URL, read with the bot token; `mimeType` is what Slack said the file is. */
  async download(url: string, mimeType?: string): Promise<Uint8Array> {
    let res: Response;
    try { res = await this.n.fetch(url, { headers: { authorization: `Bearer ${this.token}` } }); }
    catch (e) { throw new SlackError(`Slack unreachable: ${(e as Error).message}`, "retryable"); }
    if (!res.ok) throw new SlackError(`File download failed (${res.status})`, res.status >= 500 || res.status === 429 ? "retryable" : "permanent");
    // Without files:read Slack answers with its sign-in page instead of the file.
    if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !mimeType?.startsWith("text/html")) {
      throw new SlackError("Slack sent a sign-in page instead of the file; the app needs the files:read scope", "permanent");
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The bytes for an upload URL from files.getUploadURLExternal; nothing is shared until the upload is completed. */
  async upload(url: string, bytes: Uint8Array): Promise<void> {
    let res: Response;
    try { res = await this.n.fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) }); }
    catch (e) { throw new SlackError(`Slack unreachable: ${(e as Error).message}`, "retryable"); }
    if (!res.ok) throw new SlackError(`File upload failed (${res.status})`, res.status >= 500 || res.status === 429 ? "retryable" : "permanent");
  }
}
