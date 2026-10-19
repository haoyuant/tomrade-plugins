import type { ModelChatRequest, ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** Zhipu's two platforms, each with its own accounts and keys. The GLM Coding Plan's `…/api/coding/paas/v4` is left out: its keys are for the vendor's listed tools. */
export const MAINLAND = "https://open.bigmodel.cn/api/paas/v4";
export const INTERNATIONAL = "https://api.z.ai/api/paas/v4";

/** `{id}.{secret}`: a hex id, a dot, then the secret. */
const KEY = /^[0-9a-f]{32}\.[A-Za-z0-9]+$/;

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "glm",
    title: "智谱 GLM",
    baseURL: MAINLAND,
    model: "glm-5.3",
    keyPage: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    env: "ZHIPUAI_API_KEY",
    keyShapes: [KEY],
    hint: { en: "Zhipu's BigModel open platform, mainland China; reachable without a VPN", zh: "智谱开放平台，中国内地，国内可直连" }
  },
  {
    id: "glm-intl",
    title: "Z.ai",
    baseURL: INTERNATIONAL,
    model: "glm-5.3",
    keyPage: "https://z.ai/manage-apikey/apikey-list",
    env: "ZAI_API_KEY",
    keyShapes: [KEY],
    hint: { en: "Zhipu's international platform, with accounts and keys of its own", zh: "智谱国际站，账号和 Key 与 bigmodel.cn 分开" }
  }
];

/** Z.ai's addresses; any other is taken for bigmodel.cn. */
const onZai = (baseURL: string): boolean => /^https?:\/\/([^/]+\.)?z\.ai(:\d+)?(\/|$)/i.test(baseURL);

/** The chat models each platform serves, best first, for an endpoint that lists none. */
const KNOWN = {
  mainland: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5", "glm-5v-turbo", "glm-4.7", "glm-4.7-flashx", "glm-4.7-flash", "glm-4.6", "glm-4.6v"],
  international: ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]
};

export const known = (baseURL: string): string[] => [...(onZai(baseURL) ? KNOWN.international : KNOWN.mainland)];

/** What a listing has besides chat models: embeddings, images, video, speech, OCR and the phone agent. */
const NOT_CHAT = /embedding|rerank|cogview|cogvideo|vidu|image|ocr|asr|tts|realtime|voice|autoglm/i;

export const usable = (listed: string[]): string[] => listed.filter((id) => !NOT_CHAT.test(id));

/** GLM-5.3-Flash(X) and the V models (glm-5v-turbo, glm-4.6v…). Flash also reads video and files, which are not offered. */
const VISION = /^glm-(5\.3-flash|\d+(\.\d+)?v)/i;

export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return VISION.test(model) ? { inputModalities: ["image"], outputModalities: [] } : undefined;
}

/** The text models search with a `web_search` tool on chat/completions; the vision models take function tools only. */
export const searches = (model: string): boolean => /^glm-/i.test(model) && !VISION.test(model);

/** GLM-5.2 and later take `reasoning_effort`; 5.3 refuses all but low, high and max, and cannot stop thinking. */
const EFFORT = /^glm-(5\.[2-9]|[6-9])/i;
/** GLM-4.5 and later switch thinking with `thinking.type`. */
const THINKS = /^glm-(4\.[5-9]|[5-9])/i;
const QUICK = new Set(["off", "minimal", "low"]);

/**
 * GLM's own fields on chat/completions: its search tool when a request asks for
 * the web, the effort as `reasoning_effort` or the thinking switch, and the
 * wire's limits (temperature within (0, 1], `tool_choice` only `auto`, no
 * `stream_options`, `max_tokens` only).
 */
export function shape(model: string, baseURL: string, json: Record<string, unknown>, request: ModelChatRequest): Record<string, unknown> {
  const { reasoning_effort: _effort, stream_options: _usage, max_completion_tokens: max, ...out } = json;
  if (max !== undefined) out.max_tokens = max;
  if (typeof out.temperature === "number") out.temperature = Math.min(1, Math.max(0.01, out.temperature));
  if ("tool_choice" in out && out.tool_choice !== "auto") delete out.tool_choice;
  if (request.effort && EFFORT.test(model)) out.reasoning_effort = QUICK.has(request.effort) ? "low" : "high";
  else if (request.effort && THINKS.test(model)) out.thinking = { type: QUICK.has(request.effort) ? "disabled" : "enabled" };
  if (request.webSearch) {
    const search = { enable: true, search_engine: onZai(baseURL) ? "search-prime" : "search_pro", search_result: true };
    out.tools = [...((out.tools as unknown[] | undefined) ?? []), { type: "web_search", web_search: search }];
  }
  return out;
}
