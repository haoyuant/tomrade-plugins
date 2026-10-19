import type { ModelChatRequest, ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** Model Studio's OpenAI-compatible endpoints. A workspace's own (`https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`) goes in the profile's address. */
export const MAINLAND = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const INTERNATIONAL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "qwen",
    title: "通义千问 Qwen",
    baseURL: MAINLAND,
    // the alias of the latest Plus, which the endpoint answers whether or not it lists models
    model: "qwen-plus",
    keyPage: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    env: "DASHSCOPE_API_KEY",
    hint: { en: "Alibaba Cloud Bailian, mainland China; reachable without a VPN", zh: "阿里云百炼，中国内地，国内可直连" }
  },
  {
    id: "qwen-intl",
    title: "Qwen (International)",
    baseURL: INTERNATIONAL,
    model: "qwen-plus",
    keyPage: "https://modelstudio.console.alibabacloud.com/model/settings/api-key",
    hint: { en: "Alibaba Cloud Model Studio, Singapore; its keys work only there", zh: "阿里云 Model Studio 国际站（新加坡），Key 只在那里可用" }
  }
];

/** What the listing has besides chat models: embeddings, speech, images and video. */
const NOT_CHAT = /embedding|rerank|tts|asr|realtime|paraformer|cosyvoice|sambert|wanx?\d|wan2|image|video|-mt-|translate/i;

/** The chat models, as listed: Qwen's, and the other vendors' Model Studio serves on the same key. */
export const usable = (listed: string[]): string[] => listed.filter((id) => !NOT_CHAT.test(id));

/** Qwen's commercial models search the web themselves when a request sets `enable_search`. */
export const searches = (model: string): boolean => /^qwen(\d+(\.\d+)?)?-(max|plus|flash|turbo)\b/i.test(model);

/** The hybrid models, thinking by default, that `enable_thinking` switches; the thinking-only previews refuse to stop. */
const HYBRID = /^qwen3(\.\d+)?-(max|plus|flash)\b/i;
const QUICK = new Set(["off", "minimal", "low"]);

/** VL, Omni and QVQ read pictures. */
export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return /-vl|omni|qvq/i.test(model) ? { inputModalities: ["image"], outputModalities: [] } : undefined;
}

/**
 * Qwen's own fields on chat/completions: its search when a request asks for
 * the web, and its thinking switch for the effort. `reasoning_effort` is not
 * part of DashScope's API and is never sent.
 */
export function shape(model: string, json: Record<string, unknown>, request: ModelChatRequest): Record<string, unknown> {
  const { reasoning_effort: _effort, ...out } = json;
  if (request.webSearch) out.enable_search = true;
  if (request.effort && HYBRID.test(model) && !/preview/i.test(model)) out.enable_thinking = !QUICK.has(request.effort);
  return out;
}
