import type { ModelChat, ModelChatEvent, ModelChatRequest, ModelInput } from "@tomradex/plugin-sdk";
import { modern, readGemini, sseData, toGemini } from "./gemini.js";
import { KEYED, authorize, geminiId, googleError, projectOf, type Auth } from "./vertex.js";

/** The MIME types Vertex reads inline for each kind of media; it takes no GIFs. */
const MIMES: Record<string, string[]> = {
  image: ["image/png", "image/jpeg", "image/webp"],
  pdf: ["application/pdf"],
  audio: ["audio/wav", "audio/mpeg"],
  video: ["video/mp4", "video/webm"]
};

/** The request was fine, the moment was not: throttled, overloaded, or Google's own hiccup. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRIES = 2;

/** A 429 naming a zero limit is a quota the project does not have, which waiting will not change. */
const unavailable = (text: string): boolean => /limit: ?0\b/.test(text);

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export interface GeminiModelOptions extends Auth {
  baseURL: string;
  model: string;
  inputModalities?: ModelInput[];
  /** The plugin's namespace, under which Gemini's own turns are kept between the requests of a turn. */
  provider: string;
  retryDelayMs?: number;
}

/**
 * Gemini on Vertex's own streamGenerateContent, which keeps the thought
 * signatures Gemini 3 needs back in a tool loop. It does not claim native web
 * search: Vertex takes Google Search only on a request without functions, and
 * the assistant offers functions on every step, so the app's search serves it.
 */
export class GeminiModel implements ModelChat {
  /** A model that turned down Google Search is asked without it from then on. */
  private search = true;
  /** Likewise a thinking level. */
  private thinking = true;

  constructor(private readonly options: GeminiModelOptions) {}

  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: true,
      mediaInput: (this.options.inputModalities ?? []).flatMap((m) => MIMES[m] ?? []),
      nativeWebSearch: false
    };
  }

  async *chat(request: ModelChatRequest, signal?: AbortSignal): AsyncIterable<ModelChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new Error(`This model profile does not accept ${block.media.mime}`);
    }
    const { apiKey, baseURL, provider } = this.options;
    const model = geminiId(this.options.model);
    const url = `${apiKey.trim() ? KEYED : baseURL.replace(/\/$/, "")}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    for (let attempt = 1; ; attempt += 1) {
      const search = !!request.webSearch && this.search && !request.tools?.length;
      const thinks = this.thinking && !!request.effort && modern(model);
      const body = JSON.stringify(toGemini(model, request, { provider, search, thinking: thinks }));
      // asked for every try: the token may have been renewed
      const headers = { "content-type": "application/json", ...(await authorize(this.options, projectOf(baseURL))) };
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body, signal });
      } catch (error) {
        if (signal?.aborted || attempt > RETRIES) throw error;
        const delayMs = (this.options.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        yield { type: "retry", attempt, max: RETRIES, reason: cause ?? (error instanceof Error ? error.message : String(error)), delayMs };
        await pause(delayMs, signal);
        continue;
      }
      if (res.ok && res.body) {
        yield* readGemini(sseData(res.body as unknown as AsyncIterable<Uint8Array>), provider);
        return;
      }
      const text = await res.text().catch(() => "");
      if (TRANSIENT.has(res.status) && !(res.status === 429 && unavailable(text)) && attempt <= RETRIES) {
        const after = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : (this.options.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
        yield { type: "retry", attempt, max: RETRIES, reason: `HTTP ${res.status}`, delayMs };
        await pause(delayMs, signal);
        continue;
      }
      // never a failed answer for a search the request only asked for: the same request again, without it
      if (search && (res.status === 400 || res.status === 403) && /google[_ ]?search|grounding/i.test(text)) {
        this.search = false;
        continue;
      }
      if (thinks && res.status === 400 && /thinking/i.test(text)) {
        this.thinking = false;
        continue;
      }
      throw new Error(`Vertex AI request failed ${googleError(res.status, text)}`);
    }
  }
}

/** An open model or Claude asked for with an API key, which reaches Gemini only. */
export const keyedOnly = (model: string, what: string): ModelChat => ({
  capabilities: { tools: true, streaming: true, json: true },
  async *chat() {
    throw new Error(`${model} is ${what}, which Vertex AI serves only to Google Cloud credentials: use the Google Vertex AI preset (gcloud), or pick a Gemini model for this API key`);
  }
});
