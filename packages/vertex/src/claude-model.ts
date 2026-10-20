import type { ModelChat, ModelChatEvent, ModelChatRequest, ModelInput } from "@tomradex/plugin-sdk";
import { claudeBody, keeps, readClaude, toMessages } from "./claude.js";
import { sseData } from "./gemini.js";
import { authorize, googleError, projectOf, type Auth } from "./vertex.js";

const MIMES: Record<string, string[]> = { image: ["image/png", "image/jpeg", "image/gif", "image/webp"], pdf: ["application/pdf"] };

/** Anthropic's 529 is its own "overloaded". */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRIES = 2;
/** A long server-side search pauses the turn; each pause is resumed, up to this many. */
const CONTINUATIONS = 5;

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export interface ClaudeModelOptions extends Auth {
  baseURL: string;
  model: string;
  inputModalities?: ModelInput[];
  /** The plugin's namespace, under which Claude's own turns are kept between the requests of a turn. */
  provider: string;
  retryDelayMs?: number;
}

/** Claude on Vertex's streamRawPredict: Anthropic's Messages API, its stream and its web search, behind Google's credentials. */
export class ClaudeModel implements ModelChat {
  /** A project or model that turned the web search down is asked without it from then on. */
  private search = true;
  /** Likewise Claude's effort. */
  private effort = true;

  constructor(private readonly options: ClaudeModelOptions) {}

  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: false,
      mediaInput: (this.options.inputModalities ?? []).flatMap((m) => MIMES[m] ?? []),
      nativeWebSearch: this.search
    };
  }

  async *chat(request: ModelChatRequest, signal?: AbortSignal): AsyncIterable<ModelChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new Error(`This model profile does not accept ${block.media.mime}`);
    }
    const { baseURL, model, provider } = this.options;
    const url = `${baseURL.replace(/\/$/, "")}/publishers/anthropic/models/${encodeURIComponent(model)}:streamRawPredict`;
    const sources = new Map<string, string>();
    // what Claude wrote across every pause, as it wrote it
    const written: Record<string, unknown>[] = [];
    let stop: "end" | "tool_use" | "max_tokens" | "refusal" = "end";
    for (let round = 0; ; round += 1) {
      const messages = round ? [...toMessages(request, provider), { role: "assistant" as const, content: written }] : undefined;
      let paused = false;
      for (let attempt = 1; ; attempt += 1) {
        const search = !!request.webSearch && this.search;
        const body = JSON.stringify(claudeBody(model, request, { provider, search, effort: this.effort }, messages));
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
          const turn = yield* readClaude(sseData(res.body as unknown as AsyncIterable<Uint8Array>), sources);
          written.push(...turn.written);
          stop = turn.stop;
          paused = turn.paused;
          break;
        }
        const text = await res.text().catch(() => "");
        if (TRANSIENT.has(res.status) && attempt <= RETRIES) {
          const after = Number(res.headers.get("retry-after"));
          const delayMs = Number.isFinite(after) && after > 0 && after <= 20 ? after * 1000 : (this.options.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
          yield { type: "retry", attempt, max: RETRIES, reason: `HTTP ${res.status}`, delayMs };
          await pause(delayMs, signal);
          continue;
        }
        // never a failed answer for a search the request only asked for: the same request again, without it
        if (search && (res.status === 400 || res.status === 403) && /web[_ ]?search/i.test(text)) {
          this.search = false;
          continue;
        }
        if (this.effort && res.status === 400 && /output_config|effort/i.test(text)) {
          this.effort = false;
          continue;
        }
        throw new Error(`Claude on Vertex AI request failed ${googleError(res.status, text)}`);
      }
      if (!paused || round >= CONTINUATIONS) break;
    }
    if (sources.size) yield { type: "text", delta: "\n\n" + [...sources].map(([link, title]) => `- [${title.replace(/[[\]]/g, "")}](${link})`).join("\n") };
    if (keeps(written)) yield { type: "native", provider, data: written };
    yield { type: "stop", reason: stop };
  }
}
