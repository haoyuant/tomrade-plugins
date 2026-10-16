import { ImDeliveryError } from "@tomradex/plugin-sdk";

export interface Net {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** The runtime's network, read when a connection opens, so a test can stand in for Feishu. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis), WebSocket: globalThis.WebSocket });

export type Domain = "feishu" | "lark";
export const BASE: Record<Domain, string> = { feishu: "https://open.feishu.cn", lark: "https://open.larksuite.com" };

/** Codes that mean the tenant token went stale: fetch a new one and try once more. */
const STALE_TOKEN = new Set([99991661, 99991663, 99991664, 99991665, 99991668]);
/** Frequency limits: the app's API quota, and a chat's message rate. */
const LIMITED = new Set([99991400, 230020]);
/** The app has not been granted the scope, or not published with it. */
export const NO_SCOPE = new Set([99991672, 99991679]);

export class FeishuError extends ImDeliveryError {
  constructor(message: string, disposition: "retryable" | "uncertain" | "permanent", readonly code?: number, retryAfterMs?: number) {
    super(message, disposition, retryAfterMs);
  }
}

type Body = Record<string, unknown>;

/**
 * Feishu's open API with a tenant token kept fresh. Every write the adapter
 * makes is idempotent (a message carries a uuid Feishu deduplicates on, card
 * updates carry a rising sequence), so a lost answer is safe to retry.
 */
export class Api {
  private token: { value: string; until: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(readonly base: string, private readonly creds: { appId: string; appSecret: string }, private readonly n: Net) {}

  async tenantToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    this.pending ??= (async () => {
      try {
        const res = await this.send("POST", "/open-apis/auth/v3/tenant_access_token/internal", { app_id: this.creds.appId, app_secret: this.creds.appSecret }, null);
        const body = await res.json().catch(() => ({})) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
        if (body.code !== 0 || !body.tenant_access_token) {
          throw new FeishuError(`Feishu refused the app credentials${body.msg ? `: ${body.msg}` : ""}`, res.status >= 500 ? "retryable" : "permanent", body.code);
        }
        // Renew well before it lapses; Feishu hands out a fresh one in the last half hour.
        this.token = { value: body.tenant_access_token, until: Date.now() + Math.max(60, (body.expire ?? 7200) - 600) * 1000 };
        return this.token.value;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }

  private async send(method: string, path: string, body: Body | FormData | undefined, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers["content-type"] = "application/json; charset=utf-8"; payload = JSON.stringify(body); }
    try { return await this.n.fetch(`${this.base}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) }); }
    catch (e) { throw new FeishuError(`Feishu unreachable: ${(e as Error).message}`, "retryable"); }
  }

  /** A JSON call; resolves to the whole answer once `code` is 0. */
  async call<T = Body>(method: string, path: string, body?: Body | FormData): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(method, path, body, await this.tenantToken());
      const answer = await res.json().catch(() => null) as (Body & { code?: number; msg?: string }) | null;
      const code = answer?.code;
      if (code === 0 && res.ok) return answer as T;
      if (code !== undefined && STALE_TOKEN.has(code) && attempt === 0) { this.token = null; continue; }
      if (res.status === 429 || (code !== undefined && LIMITED.has(code))) {
        const reset = Number(res.headers.get("x-ogw-ratelimit-reset"));
        throw new FeishuError("Feishu rate limit", "retryable", code, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000);
      }
      if (res.status >= 500) throw new FeishuError(`Feishu error ${res.status}`, "retryable", code);
      throw new FeishuError(`Feishu refused (${code ?? res.status}${answer?.msg ? `: ${answer.msg}` : ""})`, "permanent", code);
    }
  }

  /** A file the API serves; `probe` reads only what the headers say. */
  async fetchFile(path: string, opts: { probe?: boolean } = {}): Promise<{ bytes?: Uint8Array; size: number; mimeType?: string; name?: string }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send("GET", path, undefined, await this.tenantToken());
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const answer = await res.json().catch(() => ({})) as { code?: number; msg?: string };
        if (answer.code !== undefined && STALE_TOKEN.has(answer.code) && attempt === 0) { this.token = null; continue; }
        throw new FeishuError(`Feishu refused the file (${answer.code ?? res.status}${answer.msg ? `: ${answer.msg}` : ""})`, res.status >= 500 ? "retryable" : "permanent", answer.code);
      }
      if (!res.ok) throw new FeishuError(`File download failed (${res.status})`, res.status >= 500 ? "retryable" : "permanent");
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
      const meta = { ...(type ? { mimeType: type.split(";")[0]!.trim() } : {}), ...(name ? { name: decodeURIComponent(name) } : {}) };
      const length = Number(res.headers.get("content-length"));
      if (opts.probe && Number.isFinite(length) && length > 0) {
        void res.body?.cancel().catch(() => {});
        return { size: length, ...meta };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, size: bytes.byteLength, ...meta };
    }
  }

  /** The long connection's address, asked for with the app's own credentials. */
  async endpoint(): Promise<Response> {
    try {
      return await this.n.fetch(`${this.base}/callback/ws/endpoint`, {
        method: "POST", headers: { "content-type": "application/json", locale: "zh" },
        body: JSON.stringify({ AppID: this.creds.appId, AppSecret: this.creds.appSecret })
      });
    } catch (e) { throw new FeishuError(`Feishu unreachable: ${(e as Error).message}`, "retryable"); }
  }
}
