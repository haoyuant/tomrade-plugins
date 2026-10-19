import { expect, it } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelProviderSpec } from "@tomradex/plugin-sdk";
import qwen from "../src/index.js";
import { INTERNATIONAL, MAINLAND, media, searches, shape, usable } from "../src/qwen.js";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered() {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string }[] = [];
  const ctx = {
    namespace: "qwen",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string }) => (listed.push(endpoint), { ok: true as const, models: ["qwen-plus"] })
    }
  };
  await (qwen as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });

it("registers a provider with mainland and international presets, the mainland address by default", async () => {
  const { spec, listed } = await registered();
  expect(spec).toMatchObject({ id: "qwen", title: { en: "Qwen (Alibaba Cloud)", zh: "通义千问（阿里云）" }, baseURL: { default: MAINLAND } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([
    ["qwen", MAINLAND, "qwen-plus", "DASHSCOPE_API_KEY"],
    ["qwen-intl", INTERNATIONAL, "qwen-plus", undefined]
  ]);
  await spec.list({ apiKey: "sk-x" }, new AbortController().signal);
  await spec.list({ baseURL: INTERNATIONAL, apiKey: "sk-y" }, new AbortController().signal);
  expect(listed).toEqual([{ baseURL: MAINLAND, apiKey: "sk-x" }, { baseURL: INTERNATIONAL, apiKey: "sk-y" }]);
});

it("builds on the app's adapter at the profile's address, searching on chat/completions for the models that can", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "qwen", baseURL: "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKey: "sk-a", model: "qwen3.8-max" });
  spec.build({ id: "b", title: "", provider: "qwen", apiKey: "sk-b", model: "qwen2.5-7b-instruct" });
  expect(built[0]).toMatchObject({ baseURL: "https://ws1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKey: "sk-a", model: "qwen3.8-max", webSearch: "chat" });
  expect(built[1]).toMatchObject({ baseURL: MAINLAND, model: "qwen2.5-7b-instruct" });
  expect(built[1]).not.toHaveProperty("webSearch");
  expect(built[0]!.body!({ model: "qwen3.8-max", reasoning_effort: "low" }, request({ webSearch: true, effort: "low" }))).toEqual({ model: "qwen3.8-max", enable_search: true, enable_thinking: false });
});

it("sets Qwen's own fields: search when asked, thinking by effort on the hybrid models, never reasoning_effort", () => {
  expect(shape("qwen-plus", { model: "qwen-plus", reasoning_effort: "high" }, request())).toEqual({ model: "qwen-plus" });
  expect(shape("qwen-plus", {}, request({ webSearch: true }))).toEqual({ enable_search: true });
  expect(shape("qwen3.7-plus", {}, request({ effort: "high" }))).toEqual({ enable_thinking: true });
  expect(shape("qwen3.7-flash", {}, request({ effort: "minimal" }))).toEqual({ enable_thinking: false });
  // the thinking-only previews cannot stop thinking, and qwen-plus's alias is left as it is
  expect(shape("qwen3.7-max-preview", {}, request({ effort: "low" }))).toEqual({});
  expect(shape("qwen-plus", {}, request({ effort: "low" }))).toEqual({});
});

it("knows which models search, which read pictures, and which of a listing are chat models", () => {
  expect(["qwen-max", "qwen-plus-latest", "qwen-flash", "qwen-turbo", "qwen3.8-max", "qwen3.6-flash-2026-04-16"].every(searches)).toBe(true);
  expect(["qwen2.5-72b-instruct", "qwq-32b", "qwen3-coder-480b"].some(searches)).toBe(false);
  expect(media("qwen-vl-max")).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(media("qwen3.8-omni-flash")).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(media("qwen-plus")).toBeUndefined();
  expect(media("qwen-plus", { inputModalities: ["image", "pdf"], outputModalities: [] })).toEqual({ inputModalities: ["image", "pdf"], outputModalities: [] });
  expect(usable(["qwen-plus", "text-embedding-v4", "qwen3-tts-flash", "wanx2.1-t2i-turbo", "qwen-mt-turbo", "qwq-plus", "deepseek-v3", "qwen-vl-max", "qwen-image-edit"])).toEqual(["qwen-plus", "qwq-plus", "deepseek-v3", "qwen-vl-max"]);
});
