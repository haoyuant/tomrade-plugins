import { ImDeliveryError } from "@tomradex/plugin-sdk";

export interface Net {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

/** The runtime's network, read when a connection opens, so a test can stand in for DingTalk. */
export const net = (): Net => ({ fetch: globalThis.fetch.bind(globalThis), WebSocket: globalThis.WebSocket });

export const API = "https://api.dingtalk.com";
export const OAPI = "https://oapi.dingtalk.com";

/** Codes that mean "slow down": message rates per robot, token and recipient, and the platform's busy answers. */
const LIMITED = /^(send\.(too\.fast|toofast|byToken\.tooFast)|too\.many\.(people|group)|toomuch\.msg|request\.too\.fast|qps\.exceed\.limit|failure\.operation\.(requestTooFast|operatingFrequencyTooFast)|system\.?[bB]usy|systemError\.busy)$/;
/** The token lapsed: fetch a new one and try once more. */
const STALE = new Set(["InvalidAuthentication", "invalidAccessToken", "accesstoken.expired"]);
const OAPI_STALE = new Set([40001, 40014, 42001]);
const OAPI_LIMITED = new Set([90002, 90005, 90006, 90018]);

export class DingTalkError extends ImDeliveryError {
  constructor(message: string, disposition: "retryable" | "uncertain" | "permanent", readonly code?: string, retryAfterMs?: number, readonly status?: number) {
    super(message, disposition, retryAfterMs);
  }
}

/** No card permission, or a template DingTalk will not use: replies fall back to Markdown messages. */
export const refusesCards = (e: unknown): boolean => e instanceof DingTalkError && e.disposition === "permanent"
  && (e.status === 403 || /permission|template|权限|模板/i.test(`${e.code ?? ""} ${e.message}`));

function refusal(res: Response, code: string | undefined, message: string | undefined, safe: boolean): DingTalkError {
  if (res.status === 429 || (res.status === 403 && /Qp[sm]Limit/i.test(code ?? "")) || LIMITED.test(code ?? "")) {
    const after = Number(res.headers.get("retry-after"));
    // A per-second gate opens again quickly; a per-minute one, or a message rate, takes its minute.
    const wait = after > 0 ? after * 1000 : /QpsLimit/i.test(code ?? "") || res.status === 429 ? 2_000 : 60_000;
    return new DingTalkError(`DingTalk rate limit (${code ?? res.status})`, "retryable", code, wait, res.status);
  }
  const what = `DingTalk refused (${code ?? res.status}${message ? `: ${message}` : ""})`;
  if (res.status >= 500) return new DingTalkError(what, safe ? "retryable" : "uncertain", code, undefined, res.status);
  return new DingTalkError(what, "permanent", code, undefined, res.status);
}

type Body = Record<string, unknown>;

/**
 * DingTalk's OpenAPI with the app's token kept fresh. Calls are `safe` when
 * repeating one cannot post twice (card writes name their card, uploads only
 * store a file); robot messages are not, so a lost answer to one is uncertain.
 */
export class Api {
  private token: { value: string; until: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(private readonly creds: { clientId: string; clientSecret: string }, private readonly n: Net) {}

  async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    this.pending ??= (async () => {
      try {
        const res = await this.send(`${API}/v1.0/oauth2/accessToken`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ appKey: this.creds.clientId, appSecret: this.creds.clientSecret }) }, true);
        const body = await res.json().catch(() => ({})) as { accessToken?: string; expireIn?: number; code?: string; message?: string };
        if (!res.ok || !body.accessToken) {
          throw new DingTalkError(`DingTalk refused the app credentials${body.message ? `: ${body.message}` : ""}`, res.status >= 500 ? "retryable" : "permanent", body.code, undefined, res.status);
        }
        // Renew well before it lapses.
        this.token = { value: body.accessToken, until: Date.now() + Math.max(60, (body.expireIn ?? 7200) - 600) * 1000 };
        return this.token.value;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }

  private async send(url: string, init: RequestInit, safe: boolean): Promise<Response> {
    try { return await this.n.fetch(url, init); }
    catch (e) { throw new DingTalkError(`DingTalk unreachable: ${(e as Error).message}`, safe ? "retryable" : "uncertain"); }
  }

  /** An OpenAPI call; resolves to DingTalk's answer when it took the request. */
  async call<T = Body>(method: string, path: string, body?: Body, safe = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.send(`${API}${path}`, { method, headers: { "x-acs-dingtalk-access-token": await this.accessToken(), "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, safe);
      const answer = await res.json().catch(() => ({})) as Body & { code?: string; message?: string };
      if (res.ok) return answer as T;
      if (attempt === 0 && (res.status === 401 || STALE.has(answer.code ?? ""))) { this.token = null; continue; }
      throw refusal(res, answer.code, answer.message, safe);
    }
  }

  /** A file for messages, through the older API; DingTalk answers with its media id. */
  async upload(type: "image" | "file", name: string, mimeType: string, bytes: Uint8Array): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append("type", type);
      form.append("media", new Blob([new Uint8Array(bytes)], { type: mimeType }), name);
      const res = await this.send(`${OAPI}/media/upload?access_token=${encodeURIComponent(await this.accessToken())}&type=${type}`, { method: "POST", body: form }, true);
      const answer = await res.json().catch(() => ({})) as { errcode?: number; errmsg?: string; media_id?: string };
      if (res.ok && answer.errcode === 0 && answer.media_id) return answer.media_id;
      if (attempt === 0 && answer.errcode !== undefined && OAPI_STALE.has(answer.errcode)) { this.token = null; continue; }
      if (res.status === 429 || (answer.errcode !== undefined && OAPI_LIMITED.has(answer.errcode))) throw new DingTalkError("DingTalk rate limit", "retryable", String(answer.errcode ?? res.status), 2_000, res.status);
      throw new DingTalkError(`DingTalk refused the file (${answer.errcode ?? res.status}${answer.errmsg ? `: ${answer.errmsg}` : ""})`, res.status >= 500 ? "retryable" : "permanent",
        String(answer.errcode ?? res.status), undefined, res.status);
    }
  }

  /** Posts to a conversation's session webhook; `ok` when DingTalk took the message. */
  async webhook(url: string, body: Body): Promise<{ ok: boolean; code?: number; message?: string }> {
    const res = await this.send(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, false);
    if (res.status >= 500) throw new DingTalkError(`DingTalk error ${res.status}`, "uncertain", undefined, undefined, res.status);
    const answer = await res.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
    return { ok: res.ok && answer.errcode === 0, ...(answer.errcode !== undefined ? { code: answer.errcode } : {}), ...(answer.errmsg ? { message: answer.errmsg } : {}) };
  }

  /** Where a file someone sent the robot can be fetched for a while. */
  async downloadUrl(downloadCode: string, robotCode: string): Promise<string> {
    const r = await this.call<{ downloadUrl?: string }>("POST", "/v1.0/robot/messageFiles/download", { downloadCode, robotCode });
    if (!r.downloadUrl) throw new DingTalkError("DingTalk gave no download address", "permanent");
    return r.downloadUrl;
  }

  /** A file from a signed storage address, never sent the token; `probe` reads only what the headers say. */
  async fetchFile(url: string, opts: { probe?: boolean } = {}): Promise<{ bytes?: Uint8Array; size: number; mimeType?: string }> {
    const u = new URL(url);
    // DingTalk hands out plain-http storage links; the same signed path is served over https.
    if (u.protocol === "http:") u.protocol = "https:";
    const res = await this.send(u.href, { method: "GET" }, true);
    if (!res.ok) throw new DingTalkError(`File download failed (${res.status})`, res.status >= 500 ? "retryable" : "permanent", undefined, undefined, res.status);
    const type = res.headers.get("content-type")?.split(";")[0]?.trim();
    const length = Number(res.headers.get("content-length"));
    if (opts.probe && Number.isFinite(length) && length > 0) {
      void res.body?.cancel().catch(() => {});
      return { size: length, ...(type ? { mimeType: type } : {}) };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, size: bytes.byteLength, ...(type ? { mimeType: type } : {}) };
  }

  /** Registers for a Stream connection: a socket address and a ticket good for one connection. */
  async openConnection(subscriptions: { type: string; topic: string }[]): Promise<Response> {
    return this.send(`${API}/v1.0/gateway/connections/open`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ clientId: this.creds.clientId, clientSecret: this.creds.clientSecret, subscriptions, ua: "tomrade-dingtalk/0.1.0" }) }, true);
  }
}
