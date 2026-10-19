import type { ModelChat, ModelChatEvent, ModelChatRequest, ModelInput } from "@tomradex/plugin-sdk";
import { authorize, failure, regionOf, type Auth } from "./bedrock.js";
import { readConverse, toConverse } from "./converse.js";

const MIMES: Record<string, string[]> = { image: ["image/png", "image/jpeg", "image/gif", "image/webp"], pdf: ["application/pdf"] };

/** The request was fine, the moment was not: throttled, overloaded, or Bedrock's own hiccup. */
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const RETRIES = 2;

const pause = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export interface BedrockOptions extends Auth {
  baseURL: string;
  model: string;
  inputModalities?: ModelInput[];
  /** The plugin's namespace, under which Claude's reasoning is kept between the requests of a turn. */
  provider: string;
  retryDelayMs?: number;
}

/** One Bedrock model over ConverseStream, signed for the profile's region. */
export class BedrockModel implements ModelChat {
  /** A model that refused Claude's effort is asked without it from then on. */
  private effort = true;

  constructor(private readonly options: BedrockOptions) {}

  get capabilities() {
    return {
      tools: true,
      streaming: true,
      json: false,
      mediaInput: (this.options.inputModalities ?? []).flatMap((m) => MIMES[m] ?? []),
      nativeWebSearch: false
    };
  }

  async *chat(request: ModelChatRequest, signal?: AbortSignal): AsyncIterable<ModelChatEvent> {
    for (const message of request.messages) for (const block of message.content) {
      if (block.type === "media" && !this.capabilities.mediaInput.includes(block.media.mime)) throw new Error(`This model profile does not accept ${block.media.mime}`);
    }
    const { baseURL, model, provider } = this.options;
    const region = regionOf(baseURL);
    const url = `${baseURL.replace(/\/$/, "")}/model/${encodeURIComponent(model)}/converse-stream`;
    for (let attempt = 1; ; attempt += 1) {
      const body = JSON.stringify(toConverse(model, request, { provider, effort: this.effort }));
      // signed for every try: a signature carries its time, and the CLI's credentials may have been renewed
      const headers = await authorize({ method: "POST", url, body }, this.options, region);
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
        yield* readConverse(res.body as unknown as AsyncIterable<Uint8Array>, provider);
        return;
      }
      if (TRANSIENT.has(res.status) && attempt <= RETRIES) {
        await res.body?.cancel().catch(() => {});
        const delayMs = (this.options.retryDelayMs ?? 1000) * 3 ** (attempt - 1);
        yield { type: "retry", attempt, max: RETRIES, reason: `HTTP ${res.status}`, delayMs };
        await pause(delayMs, signal);
        continue;
      }
      const detail = await failure(res);
      if (res.status === 400 && this.effort && /output_config|effort/i.test(detail)) {
        this.effort = false;
        continue;
      }
      throw new Error(`Bedrock request failed ${detail}`);
    }
  }
}
