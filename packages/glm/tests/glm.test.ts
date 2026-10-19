import { expect, it } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelListing, ModelProviderSpec } from "@tomradex/plugin-sdk";
import glm from "../src/index.js";
import { INTERNATIONAL, MAINLAND, known, media, searches, shape, usable } from "../src/glm.js";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build and the listing answering `answer`. */
async function registered(answer: ModelListing = { ok: true, models: ["glm-5.3"] }) {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string }[] = [];
  const ctx = {
    namespace: "glm",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string }) => (listed.push(endpoint), answer)
    }
  };
  await (glm as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });
const signal = () => new AbortController().signal;

it("registers a provider with bigmodel.cn and Z.ai presets, bigmodel.cn by default, both starting on glm-5.3", async () => {
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "glm", title: { en: "GLM (Zhipu AI)", zh: "GLM（智谱）" }, baseURL: { default: MAINLAND } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([
    ["glm", MAINLAND, "glm-5.3", "ZHIPUAI_API_KEY"],
    ["glm-intl", INTERNATIONAL, "glm-5.3", "ZAI_API_KEY"]
  ]);
  for (const preset of spec.presets!) {
    expect(preset.keyShapes!.some((shape) => shape.test("0123456789abcdef0123456789abcdef.AbCdEf0123456789"))).toBe(true);
    expect(preset.keyShapes!.some((shape) => shape.test("sk-0123456789abcdef"))).toBe(false);
  }
});

it("lists what the endpoint lists, and the platform's known models where it lists none", async () => {
  const listing = await registered({ ok: true, models: ["glm-5.3", "glm-4.7", "embedding-3"] });
  expect(await listing.spec.list({ apiKey: "k" }, signal())).toEqual({ ok: true, models: ["glm-5.3", "glm-4.7", "embedding-3"] });
  expect(listing.listed).toEqual([{ baseURL: MAINLAND, apiKey: "k" }]);

  const none = await registered({ ok: true, models: null });
  const mainland = await none.spec.list({ apiKey: "k" }, signal());
  const zai = await none.spec.list({ baseURL: INTERNATIONAL, apiKey: "k" }, signal());
  expect(mainland).toEqual({ ok: true, models: known(MAINLAND) });
  expect(zai).toEqual({ ok: true, models: known(INTERNATIONAL) });
  expect(known(MAINLAND)[0]).toBe("glm-5.3");
  expect(known(MAINLAND)).toEqual(expect.arrayContaining(["glm-5-turbo", "glm-5v-turbo", "glm-4.6v", "glm-4.7-flash", "glm-4.7-flashx"]));
  expect(known(INTERNATIONAL)).toEqual(["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7", "glm-4.6"]);
  expect(none.listed.map((l) => l.baseURL)).toEqual([MAINLAND, INTERNATIONAL]);

  // a bad key is a 401, not the known models
  const refused = await registered({ ok: false, status: 401, detail: "401 身份验证失败。" });
  expect(await refused.spec.list({ apiKey: "bad" }, signal())).toEqual({ ok: false, status: 401, detail: "401 身份验证失败。" });
});

it("builds on the app's adapter at the profile's address, searching on chat/completions for the text models", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "glm", baseURL: INTERNATIONAL, apiKey: "k.a", model: "glm-5.3" });
  spec.build({ id: "b", title: "", provider: "glm", apiKey: "k.b", model: "glm-5.3-flash" });
  expect(built[0]).toMatchObject({ baseURL: INTERNATIONAL, apiKey: "k.a", model: "glm-5.3", webSearch: "chat" });
  expect(built[1]).toMatchObject({ baseURL: MAINLAND, model: "glm-5.3-flash" });
  expect(built[1]).not.toHaveProperty("webSearch");
  const tools = [{ type: "function", function: { name: "find" } }];
  expect(built[0]!.body!({ model: "glm-5.3", reasoning_effort: "medium", tools }, request({ webSearch: true, effort: "medium" }))).toEqual({
    model: "glm-5.3",
    reasoning_effort: "high",
    tools: [...tools, { type: "web_search", web_search: { enable: true, search_engine: "search-prime", search_result: true } }]
  });
});

it("adds GLM's search tool beside the function tools, with each platform's engine", () => {
  expect(shape("glm-4.7", MAINLAND, {}, request({ webSearch: true }))).toEqual({ tools: [{ type: "web_search", web_search: { enable: true, search_engine: "search_pro", search_result: true } }] });
  expect(shape("glm-4.7", INTERNATIONAL, {}, request({ webSearch: true })).tools).toEqual([{ type: "web_search", web_search: { enable: true, search_engine: "search-prime", search_result: true } }]);
  expect(shape("glm-4.7", MAINLAND, { tools: [] }, request())).toEqual({ tools: [] });
});

it("maps the effort to reasoning_effort on GLM-5.2 and later, and to the thinking switch before", () => {
  expect(shape("glm-5.3", MAINLAND, { reasoning_effort: "minimal" }, request({ effort: "minimal" }))).toEqual({ reasoning_effort: "low" });
  expect(shape("glm-5.3", MAINLAND, { reasoning_effort: "low" }, request({ effort: "low" }))).toEqual({ reasoning_effort: "low" });
  expect(shape("glm-5.3-flashx", MAINLAND, { reasoning_effort: "medium" }, request({ effort: "medium" }))).toEqual({ reasoning_effort: "high" });
  expect(shape("glm-5.2", MAINLAND, { reasoning_effort: "high" }, request({ effort: "high" }))).toEqual({ reasoning_effort: "high" });
  // 5.3 cannot stop thinking: never `disabled`, whatever the effort
  expect(shape("glm-5.3", MAINLAND, {}, request({ effort: "minimal" }))).not.toHaveProperty("thinking");
  expect(shape("glm-5.1", MAINLAND, { reasoning_effort: "low" }, request({ effort: "low" }))).toEqual({ thinking: { type: "disabled" } });
  expect(shape("glm-5-turbo", MAINLAND, { reasoning_effort: "high" }, request({ effort: "high" }))).toEqual({ thinking: { type: "enabled" } });
  expect(shape("glm-4.6", MAINLAND, {}, request({ effort: "minimal" }))).toEqual({ thinking: { type: "disabled" } });
  expect(shape("glm-4.5-air", MAINLAND, {}, request({ effort: "medium" }))).toEqual({ thinking: { type: "enabled" } });
  // the GLM-4 models before 4.5 take neither, and a request without an effort leaves the model's default
  expect(shape("glm-4-long", MAINLAND, { reasoning_effort: "low" }, request({ effort: "low" }))).toEqual({});
  expect(shape("glm-4.7", MAINLAND, {}, request())).toEqual({});
});

it("keeps to GLM's wire: temperature within (0, 1], tool_choice only auto, no stream_options, max_tokens only", () => {
  expect(shape("glm-4.7", MAINLAND, { temperature: 0 }, request()).temperature).toBe(0.01);
  expect(shape("glm-4.7", MAINLAND, { temperature: 1.5 }, request()).temperature).toBe(1);
  expect(shape("glm-4.7", MAINLAND, { temperature: 0.3 }, request()).temperature).toBe(0.3);
  expect(shape("glm-4.7", MAINLAND, { tool_choice: "auto" }, request())).toEqual({ tool_choice: "auto" });
  expect(shape("glm-4.7", MAINLAND, { tool_choice: "none" }, request())).toEqual({});
  expect(shape("glm-4.7", MAINLAND, { tool_choice: { type: "function", function: { name: "find" } } }, request())).toEqual({});
  expect(shape("glm-4.7", MAINLAND, { stream: true, stream_options: { include_usage: true }, max_tokens: 100 }, request())).toEqual({ stream: true, max_tokens: 100 });
  expect(shape("glm-4.7", MAINLAND, { max_completion_tokens: 200 }, request())).toEqual({ max_tokens: 200 });
  expect(shape("glm-4.7", MAINLAND, { response_format: { type: "json_object" } }, request({ json: true }))).toEqual({ response_format: { type: "json_object" } });
});

it("knows which models read pictures, which search, and which of a listing are chat models", () => {
  for (const model of ["glm-5.3-flash", "glm-5.3-flashx", "glm-5v-turbo", "glm-4.6v", "glm-4.6v-flash", "glm-4.5v", "glm-4.1v-thinking-flash"]) {
    expect(media(model)).toEqual({ inputModalities: ["image"], outputModalities: [] });
    expect(searches(model)).toBe(false);
  }
  for (const model of ["glm-5.3", "glm-5.2", "glm-5-turbo", "glm-4.7-flash", "glm-4.7-flashx", "glm-4.6"]) {
    expect(media(model)).toBeUndefined();
    expect(searches(model)).toBe(true);
  }
  expect(media("glm-5.3", { inputModalities: ["image", "pdf"], outputModalities: [] })).toEqual({ inputModalities: ["image", "pdf"], outputModalities: [] });
  expect(usable(["glm-5.3", "embedding-3", "cogview-4", "cogvideox-3", "glm-image", "glm-ocr", "glm-asr-2512", "glm-tts", "glm-realtime", "glm-4-voice", "autoglm-phone", "glm-4.6v", "glm-4-long"])).toEqual(["glm-5.3", "glm-4.6v", "glm-4-long"]);
});
