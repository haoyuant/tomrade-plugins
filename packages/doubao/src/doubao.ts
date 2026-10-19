import type { ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** Ark's data-plane addresses. BytePlus also serves Europe (`https://ark.eu-west.bytepluses.com/api/v3`), which goes in the profile's address. */
export const MAINLAND = "https://ark.cn-beijing.volces.com/api/v3";
export const BYTEPLUS = "https://ark.ap-southeast.bytepluses.com/api/v3";

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "doubao",
    title: "豆包 Doubao",
    baseURL: MAINLAND,
    model: "doubao-seed-2-1-pro-260915",
    keyPage: "https://ark.volcengine.com/region:cn-beijing/apiKey",
    env: "ARK_API_KEY",
    hint: { en: "Volcengine Ark, mainland China, reachable without a VPN; switch each model on in the Ark console first", zh: "火山方舟，中国内地，国内可直连；模型需先在方舟控制台开通" }
  },
  {
    id: "doubao-byteplus",
    title: "BytePlus ModelArk",
    baseURL: BYTEPLUS,
    model: "dola-seed-2-1-turbo-260628",
    keyPage: "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey",
    hint: { en: "BytePlus ModelArk, international; its keys work only in their region, and each model is switched on in the console first", zh: "BytePlus ModelArk 国际站，Key 只在所属区域可用；模型需先在控制台开通" }
  }
];

/** Ark documents no model listing, so a key that passes gets the chat models its region serves, best first. */
const MAINLAND_MODELS = [
  "doubao-seed-2-1-pro-260915",
  "doubao-seed-2-1-lite-260915",
  "doubao-seed-2-1-turbo-260628",
  "doubao-seed-evolving",
  "glm-5-3-flash-260828",
  "deepseek-v4-1-flash-261017",
  "deepseek-v4-pro-ga-260813"
];
const BYTEPLUS_MODELS = ["dola-seed-2-1-turbo-260628", "seed-2-0-pro-260328", "seed-2-0-lite-260428", "seed-2-0-mini-260428", "seed-2-0-code-preview-260328"];

/** The known chat models at an address: BytePlus's by its host, of which Europe serves only Seed 2.0. */
export function known(baseURL: string): string[] {
  if (!/^https?:\/\/([^/]+\.)?bytepluses\.com(\/|$)/i.test(baseURL)) return MAINLAND_MODELS;
  return /^https?:\/\/ark\.eu-west\./i.test(baseURL) ? BYTEPLUS_MODELS.filter((id) => id.startsWith("seed-2-0-")) : BYTEPLUS_MODELS;
}

/** What a listing would have besides chat models: images, video, 3D, embeddings, translation and speech. */
const NOT_CHAT = /seedream|seedance|seededit|seed3d|embedding|translation|tts|asr/i;

export const usable = (listed: string[]): string[] => listed.filter((id) => !NOT_CHAT.test(id));

/** The doubao-seed models search the web themselves with `web_search` on Ark's Responses API; BytePlus documents no search. */
export const searches = (model: string): boolean => /^doubao-seed-(\d|evolving)/i.test(model);

/** Seed 2.x, GLM-5.3 Flash and DeepSeek V4.1 Flash read pictures, video and PDFs. */
const VISION = /^(doubao-|dola-)?seed-(\d|evolving)|^glm-5-3-flash|^deepseek-v4-1-flash/i;

export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return VISION.test(model) ? { inputModalities: ["image", "video", "pdf"], outputModalities: [] } : undefined;
}

/** The answer room a request without `max_tokens` gets; Ark's own default, 4096, cuts an agent's long answers short. */
export const ANSWER_TOKENS = 32768;

/**
 * Ark's own fields on chat/completions: room for a long answer when the
 * request names no limit. `max_tokens` counts only the answer there, except on
 * DeepSeek V4.1 Flash, where it includes the reasoning and defaults to 128k.
 * `max_completion_tokens` is never added: Ark refuses it beside `max_tokens`.
 */
export function shape(model: string, json: Record<string, unknown>): Record<string, unknown> {
  if ("max_tokens" in json || "max_completion_tokens" in json || /^deepseek-v4-1-flash/i.test(model)) return json;
  return { ...json, max_tokens: ANSWER_TOKENS };
}

/** The same room on the Responses API, where most of a searching Seed model's requests go. */
export function answer(json: Record<string, unknown>): Record<string, unknown> {
  return "max_output_tokens" in json ? json : { ...json, max_output_tokens: ANSWER_TOKENS };
}
