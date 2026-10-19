import type { ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** MiniMax's OpenAI-compatible endpoints. The mainland one moved from `api.minimaxi.com`, which still answers. */
export const MAINLAND = "https://api.minimax.cn/v1";
export const INTERNATIONAL = "https://api.minimax.io/v1";

/** The docs' default, and the only text model an M Plan serves. */
const START = "MiniMax-M3.1-Flash";

/** M Plan subscription keys; pay-as-you-go keys have no shape to tell them by. */
const PLAN_KEY = /^sk-cp-/;

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "minimax",
    title: "MiniMax 开放平台",
    baseURL: MAINLAND,
    model: START,
    keyPage: "https://platform.minimax.cn/user-center/basic-information/interface-key",
    env: "MINIMAX_API_KEY",
    keyShapes: [PLAN_KEY],
    hint: { en: "MiniMax, mainland China; reachable without a VPN. Pay-as-you-go and M Plan keys both work", zh: "MiniMax 开放平台，中国内地，国内可直连；按量付费和 M Plan 的 Key 都可用" }
  },
  {
    id: "minimax-intl",
    title: "MiniMax (International)",
    baseURL: INTERNATIONAL,
    model: START,
    keyPage: "https://platform.minimax.io/user-center/basic-information/interface-key",
    keyShapes: [PLAN_KEY],
    hint: { en: "MiniMax international (platform.minimax.io); its keys work only there. Pay-as-you-go and M Plan keys both work", zh: "MiniMax 国际站（platform.minimax.io），Key 只在那里可用；按量付费和 M Plan 的 Key 都可用" }
  }
];

const M3 = /^MiniMax-M3\b/i;

/** M2.x is retired: gone for new accounts since 2026-10-19 and for everyone on 2026-11-18, and an M Plan already answers it with M3.1-Flash. */
const RETIRED = /^(MiniMax-)?M2\b/i;
/** What the listing may have besides chat models: speech, images, video and music. */
const NOT_CHAT = /speech|image|video|music|hailuo|embo|^MiniMax-H\d/i;

/** The chat models a key can use, as listed. */
export const usable = (listed: string[]): string[] => listed.filter((id) => !RETIRED.test(id) && !NOT_CHAT.test(id));

/** M3.x searches the web itself with the `web_search` server tool, which MiniMax serves on its Responses API only. */
export const searches = (model: string): boolean => M3.test(model);

/** M3.x reads pictures. */
export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return M3.test(model) ? { inputModalities: ["image"], outputModalities: [] } : undefined;
}

/** The one model whose thinking depth `reasoning_effort` sets; the others ignore it. */
const TUNES = /^MiniMax-M3\.1-Flash/i;
/** M3.1-Flash's scale. It always thinks: `none` is refused and `minimal` is not on it, so the least asks for `low`. */
const SCALE = new Set(["low", "medium", "high", "xhigh", "max"]);
const LEAST = new Set(["off", "none", "minimal"]);

/**
 * MiniMax's own fields on chat/completions: thinking split out to
 * `reasoning_content`, which the adapter does not read, instead of `<think>`
 * tags in the answer; the effort on M3.1-Flash's scale and on no other model;
 * the token limit under its current name; the temperature within [0, 2].
 * `thinking` is never sent: M3.1-Flash refuses `disabled`.
 */
export function shape(model: string, json: Record<string, unknown>): Record<string, unknown> {
  const { reasoning_effort: effort, max_tokens: limit, ...out } = json;
  out.reasoning_split = true;
  const level = LEAST.has(String(effort)) ? "low" : String(effort);
  if (TUNES.test(model) && SCALE.has(level)) out.reasoning_effort = level;
  if (limit !== undefined) out.max_completion_tokens = limit;
  if (typeof out.temperature === "number") out.temperature = Math.min(2, Math.max(0, out.temperature));
  return out;
}

/**
 * The same on the Responses API, where most of a searching M3.x's requests go:
 * the effort on M3.1-Flash's scale and on no other model, and `tool_choice`
 * only as `auto`, the one MiniMax documents there.
 */
export function answer(model: string, json: Record<string, unknown>): Record<string, unknown> {
  const { reasoning, tool_choice: choice, ...out } = json as { reasoning?: { effort?: string }; tool_choice?: unknown } & Record<string, unknown>;
  const level = LEAST.has(String(reasoning?.effort)) ? "low" : String(reasoning?.effort);
  if (TUNES.test(model) && SCALE.has(level)) out.reasoning = { ...reasoning, effort: level };
  if (choice === "auto") out.tool_choice = choice;
  return out;
}
