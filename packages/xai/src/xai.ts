import type { ModelListing, ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** xAI's OpenAI-compatible API. */
export const API = "https://api.x.ai/v1";

/** The numbered Groks (grok-4.7, grok-5). grok-4.20's two digits are older than grok-4.3, and stay out. */
const NUMBERED = /^grok-\d+(\.\d)?$/i;

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "xai",
    title: "xAI Grok",
    baseURL: API,
    model: "grok-4.7",
    // a key that does not list grok-4.7 starts on the newest numbered Grok
    prefer: [NUMBERED],
    keyPage: "https://console.x.ai/team/default/api-keys",
    env: "XAI_API_KEY",
    keyShapes: [/^xai-/],
    hint: { en: "Grok models, from a paid xAI API account", zh: "Grok 模型，需要付费的 xAI API 账户" }
  }
];

/** What `GET /models` has besides chat models: Imagine's pictures and video, voice and embeddings. */
const NOT_CHAT = /imagine|image|video|voice|tts|transcribe|embed/i;
/** The multi-agent model takes no function tools and no chat/completions, so it cannot run the assistant's tool loop. */
const MULTI_AGENT = /multi-agent/i;

/** The chat models, the numbered Groks first, newest first. */
export function usable(listed: string[]): string[] {
  const chat = listed.filter((id) => !NOT_CHAT.test(id) && !MULTI_AGENT.test(id));
  const numbered = chat.filter((id) => NUMBERED.test(id)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  return [...numbered, ...chat.filter((id) => !NUMBERED.test(id))];
}

/** Grok 4.x and later; grok-build and the retired grok-4-… ids are not. */
const GROK4 = /^grok-(4\.\d+|([5-9]|\d{2,})(\.\d+)?)(-|$)/i;

/** Grok 4.x and later search the web themselves on the Responses API (`web_search`); Live Search on chat/completions is gone. */
export const searches = (model: string): boolean => GROK4.test(model);

/** Grok 4.x and later read pictures, unless the listing says otherwise. */
export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return GROK4.test(model) ? { inputModalities: ["image"], outputModalities: [] } : undefined;
}

interface LanguageModel {
  id?: string;
  input_modalities?: unknown;
}

/**
 * `GET /language-models`: the chat models alone, each saying whether it reads
 * pictures. Null where the address has no such listing, for `GET /models` to answer.
 */
export async function languageModels(baseURL: string, apiKey: string, signal: AbortSignal): Promise<ModelListing | null> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/language-models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (res.status === 404 || res.status === 405) return null;
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: `${res.status} ${text.slice(0, 300)}` };
  const models = ((JSON.parse(text) as { models?: LanguageModel[] }).models ?? []).filter((m): m is LanguageModel & { id: string } => typeof m.id === "string" && !!m.id);
  const capabilities: Record<string, ModelMedia> = {};
  for (const m of models) if (Array.isArray(m.input_modalities)) capabilities[m.id] = { inputModalities: m.input_modalities.includes("image") ? ["image"] : [], outputModalities: [] };
  return { ok: true, models: models.length ? models.map((m) => m.id) : null, capabilities };
}

/**
 * xAI's chat/completions: `max_completion_tokens` for the deprecated
 * `max_tokens`, and an effort it takes. The app's "minimal" is `low`, the least
 * Grok thinks; the non-reasoning models take none.
 */
export function shape(model: string, json: Record<string, unknown>): Record<string, unknown> {
  const { max_tokens: tokens, reasoning_effort: effort, ...out } = json;
  if (tokens !== undefined) out.max_completion_tokens = tokens;
  if (effort !== undefined && !/non-reasoning/i.test(model)) out.reasoning_effort = effort === "minimal" ? "low" : effort;
  return out;
}
