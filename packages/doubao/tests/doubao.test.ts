import { expect, it } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelListing, ModelProviderSpec } from "@tomradex/plugin-sdk";
import doubao from "../src/index.js";
import { ANSWER_TOKENS, BYTEPLUS, MAINLAND, known, media, searches, shape, usable } from "../src/doubao.js";

const EUROPE = "https://ark.eu-west.bytepluses.com/api/v3";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build and `listCompatible` answering `listing`. */
async function registered(listing: ModelListing = { ok: true, models: null }) {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string }[] = [];
  const ctx = {
    namespace: "doubao",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string }) => (listed.push(endpoint), listing)
    }
  };
  await (doubao as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });
const signal = () => new AbortController().signal;

it("registers a provider with Volcengine Ark and BytePlus ModelArk presets, the mainland address by default", async () => {
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "doubao", title: { en: "Doubao (Volcengine Ark)", zh: "豆包（火山方舟）" }, baseURL: { default: MAINLAND } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([
    ["doubao", MAINLAND, "doubao-seed-2-1-pro-260915", "ARK_API_KEY"],
    ["doubao-byteplus", BYTEPLUS, "dola-seed-2-1-turbo-260628", undefined]
  ]);
  // the Coding Plan address is not offered, and keys carry no shape to guess them by
  expect(spec.presets!.some((p) => p.baseURL?.includes("/coding/"))).toBe(false);
  expect(spec.presets!.every((p) => !p.keyShapes)).toBe(true);
});

it("offers the region's known models when the address has no listing, at the address the profile names", async () => {
  const { spec, listed } = await registered();
  expect(await spec.list({ apiKey: "k1" }, signal())).toEqual({ ok: true, models: known(MAINLAND) });
  expect(await spec.list({ baseURL: BYTEPLUS, apiKey: "k2" }, signal())).toEqual({ ok: true, models: known(BYTEPLUS) });
  expect(await spec.list({ baseURL: EUROPE, apiKey: "k3" }, signal())).toEqual({ ok: true, models: known(EUROPE) });
  expect(listed).toEqual([{ baseURL: MAINLAND, apiKey: "k1" }, { baseURL: BYTEPLUS, apiKey: "k2" }, { baseURL: EUROPE, apiKey: "k3" }]);
  expect(known(MAINLAND)[0]).toBe("doubao-seed-2-1-pro-260915");
  expect(known(MAINLAND)).not.toContain("doubao-seed-2-0-pro-260215");
  expect(known(BYTEPLUS)[0]).toBe("dola-seed-2-1-turbo-260628");
  expect(known(EUROPE)).toEqual(["seed-2-0-pro-260328", "seed-2-0-lite-260428", "seed-2-0-mini-260428", "seed-2-0-code-preview-260328"]);
});

it("keeps a listing the address has, and a refused key fails the check", async () => {
  const listing = { ok: true as const, models: ["doubao-seed-2-1-pro-260915", "doubao-seedream-5-0-260128"], capabilities: {} };
  expect(await (await registered(listing)).spec.list({ apiKey: "k" }, signal())).toEqual(listing);
  const refused = { ok: false as const, status: 401, detail: "401 AuthenticationError" };
  expect(await (await registered(refused)).spec.list({ apiKey: "bad" }, signal())).toEqual(refused);
});

it("builds on the app's adapter at the profile's address, searching on the Responses API for the doubao-seed models", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "doubao", apiKey: "k-a", model: "doubao-seed-2-1-pro-260915" });
  spec.build({ id: "b", title: "", provider: "doubao", apiKey: "k-b", model: "deepseek-v4-pro-ga-260813" });
  spec.build({ id: "c", title: "", provider: "doubao", baseURL: BYTEPLUS, apiKey: "k-c", model: "dola-seed-2-1-turbo-260628" });
  expect(built[0]).toMatchObject({ baseURL: MAINLAND, apiKey: "k-a", model: "doubao-seed-2-1-pro-260915", webSearch: "responses" });
  expect(built[1]).toMatchObject({ baseURL: MAINLAND, model: "deepseek-v4-pro-ga-260813" });
  expect(built[1]).not.toHaveProperty("webSearch");
  expect(built[2]).toMatchObject({ baseURL: BYTEPLUS, model: "dola-seed-2-1-turbo-260628" });
  expect(built[2]).not.toHaveProperty("webSearch");
  expect(built[0]!.body!({ model: "doubao-seed-2-1-pro-260915", reasoning_effort: "low" }, request({ effort: "low" }))).toEqual({ model: "doubao-seed-2-1-pro-260915", reasoning_effort: "low", max_tokens: ANSWER_TOKENS });
});

it("gives a request without a limit room for a long answer, and passes the effort through as it is", () => {
  expect(ANSWER_TOKENS).toBe(32768);
  expect(shape("doubao-seed-2-1-pro-260915", { model: "m", reasoning_effort: "minimal" })).toEqual({ model: "m", reasoning_effort: "minimal", max_tokens: ANSWER_TOKENS });
  expect(shape("seed-2-0-pro-260328", { max_tokens: 1 })).toEqual({ max_tokens: 1 });
  expect(shape("glm-5-3-flash-260828", { max_completion_tokens: 2000 })).toEqual({ max_completion_tokens: 2000 });
  // DeepSeek V4.1 Flash counts its reasoning in max_tokens and defaults to 128k
  expect(shape("deepseek-v4-1-flash-261017", { model: "m" })).toEqual({ model: "m" });
  const shaped = shape("doubao-seed-evolving", {});
  expect(shaped).not.toHaveProperty("max_completion_tokens");
  expect(shaped).not.toHaveProperty("thinking");
});

it("knows which models search, which read pictures, video and PDFs, and which of a listing are chat models", () => {
  expect(["doubao-seed-2-1-pro-260915", "doubao-seed-2-1-lite-260915", "doubao-seed-2-1-turbo-260628", "doubao-seed-evolving"].every(searches)).toBe(true);
  expect(["glm-5-3-flash-260828", "deepseek-v4-1-flash-261017", "deepseek-v4-pro-ga-260813", "dola-seed-2-1-turbo-260628", "seed-2-0-pro-260328", "doubao-seed-character-251128"].some(searches)).toBe(false);
  const reads = { inputModalities: ["image", "video", "pdf"], outputModalities: [] };
  for (const model of ["doubao-seed-2-1-pro-260915", "doubao-seed-evolving", "dola-seed-2-1-turbo-260628", "seed-2-0-code-preview-260328", "glm-5-3-flash-260828", "deepseek-v4-1-flash-261017"]) expect(media(model)).toEqual(reads);
  expect(media("deepseek-v4-pro-ga-260813")).toBeUndefined();
  expect(media("glm-5-2-260617")).toBeUndefined();
  expect(media("glm-5-2-260617", { inputModalities: ["image"], outputModalities: [] })).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(usable(["doubao-seed-2-1-pro-260915", "doubao-seedream-5-0-260128", "doubao-seedance-2-5-260915", "doubao-embedding-vision-250615", "doubao-seed-translation-250915", "glm-5-3-flash-260828"])).toEqual(["doubao-seed-2-1-pro-260915", "glm-5-3-flash-260828"]);
});
