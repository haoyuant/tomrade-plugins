import { expect, it } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelProviderSpec } from "@tomradex/plugin-sdk";
import minimax from "../src/index.js";
import { INTERNATIONAL, MAINLAND, answer, media, searches, shape, usable } from "../src/minimax.js";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered() {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string }[] = [];
  const ctx = {
    namespace: "minimax",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string }) => (listed.push(endpoint), { ok: true as const, models: ["MiniMax-M3.1-Flash"] })
    }
  };
  await (minimax as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });

it("registers a provider with mainland and international presets, the mainland address by default", async () => {
  const { spec, listed } = await registered();
  expect(spec).toMatchObject({ id: "minimax", title: { en: "MiniMax", zh: "MiniMax" }, baseURL: { default: MAINLAND } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([
    ["minimax", "https://api.minimax.cn/v1", "MiniMax-M3.1-Flash", "MINIMAX_API_KEY"],
    ["minimax-intl", "https://api.minimax.io/v1", "MiniMax-M3.1-Flash", undefined]
  ]);
  // an M Plan key picks a MiniMax preset; a pay-as-you-go key has no shape to go by
  expect(spec.presets!.every((p) => p.keyShapes!.some((shape) => shape.test("sk-cp-abc123")))).toBe(true);
  expect(spec.presets!.some((p) => p.keyShapes!.some((shape) => shape.test("sk-abc123")))).toBe(false);
  await spec.list({ apiKey: "sk-x" }, new AbortController().signal);
  await spec.list({ baseURL: INTERNATIONAL, apiKey: "sk-cp-y" }, new AbortController().signal);
  expect(listed).toEqual([{ baseURL: MAINLAND, apiKey: "sk-x" }, { baseURL: INTERNATIONAL, apiKey: "sk-cp-y" }]);
});

it("builds on the app's adapter at the profile's address, searching on the Responses API for M3.x", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "minimax", baseURL: INTERNATIONAL, apiKey: "sk-cp-a", model: "MiniMax-M3.1-Flash", inputModalities: ["image"] });
  spec.build({ id: "b", title: "", provider: "minimax", apiKey: "sk-b", model: "MiniMax-Text-01" });
  expect(built[0]).toMatchObject({ baseURL: INTERNATIONAL, apiKey: "sk-cp-a", model: "MiniMax-M3.1-Flash", inputModalities: ["image"], webSearch: "responses" });
  expect(built[1]).toMatchObject({ baseURL: MAINLAND, model: "MiniMax-Text-01" });
  expect(built[1]).not.toHaveProperty("webSearch");
  expect(built[0]!.body!({ model: "MiniMax-M3.1-Flash", max_tokens: 4096, reasoning_effort: "minimal" }, request({ effort: "minimal", maxTokens: 4096 }))).toEqual({
    model: "MiniMax-M3.1-Flash",
    reasoning_split: true,
    reasoning_effort: "low",
    max_completion_tokens: 4096
  });
});

it("shapes chat/completions as MiniMax takes it: thinking apart, effort on M3.1-Flash only, the current token field, temperature in range", () => {
  expect(shape("MiniMax-M3.1-Flash", { model: "MiniMax-M3.1-Flash" })).toEqual({ model: "MiniMax-M3.1-Flash", reasoning_split: true });
  expect(["minimal", "low", "medium", "high"].map((effort) => shape("MiniMax-M3.1-Flash", { reasoning_effort: effort }).reasoning_effort)).toEqual(["low", "low", "medium", "high"]);
  // M3 and the rest have no depth to set
  expect(shape("MiniMax-M3", { reasoning_effort: "high" })).toEqual({ reasoning_split: true });
  expect(shape("MiniMax-M3.1-Flash", { reasoning_effort: "turbo" })).toEqual({ reasoning_split: true });
  expect(shape("MiniMax-M3", { max_tokens: 2048 })).toEqual({ reasoning_split: true, max_completion_tokens: 2048 });
  expect([-1, 0.7, 2.5].map((temperature) => shape("MiniMax-M3", { temperature }).temperature)).toEqual([0, 0.7, 2]);
  // what MiniMax would refuse is never added, and the rest goes as the adapter sent it
  const tools = { tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: "auto", response_format: { type: "json_object" } };
  expect(shape("MiniMax-M3.1-Flash", { ...tools, stream: true })).toEqual({ ...tools, stream: true, reasoning_split: true });
});

it("shapes the Responses body too: effort on M3.1-Flash's scale only, tool_choice only as auto", () => {
  expect(answer("MiniMax-M3.1-Flash", { model: "MiniMax-M3.1-Flash", reasoning: { effort: "minimal" }, tool_choice: "auto" })).toEqual({ model: "MiniMax-M3.1-Flash", reasoning: { effort: "low" }, tool_choice: "auto" });
  expect(answer("MiniMax-M3.1-Flash", { reasoning: { effort: "high" }, tool_choice: { type: "function", name: "add" } })).toEqual({ reasoning: { effort: "high" } });
  expect(answer("MiniMax-M3", { reasoning: { effort: "high" }, stream: true })).toEqual({ stream: true });
});

it("knows which models search, which read pictures, and which of a listing are usable chat models", () => {
  expect(["MiniMax-M3.1-Flash", "MiniMax-M3"].every(searches)).toBe(true);
  expect(["MiniMax-M2.7", "MiniMax-Text-01"].some(searches)).toBe(false);
  expect(media("MiniMax-M3.1-Flash")).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(media("MiniMax-M3")).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(media("MiniMax-M2.7")).toBeUndefined();
  expect(media("MiniMax-M3", { inputModalities: ["image", "video"], outputModalities: [] })).toEqual({ inputModalities: ["image", "video"], outputModalities: [] });
  expect(usable(["MiniMax-M3", "MiniMax-M3.1-Flash", "MiniMax-M2.7", "MiniMax-M2.5-highspeed", "M2-her", "speech-2.8-hd", "image-01", "MiniMax-Hailuo-2.3", "MiniMax-H3"])).toEqual(["MiniMax-M3", "MiniMax-M3.1-Flash"]);
});
