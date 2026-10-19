import { afterEach, expect, it, vi } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelListing, ModelProviderSpec } from "@tomradex/plugin-sdk";
import xai from "../src/index.js";
import { API, answer, media, searches, shape, usable } from "../src/xai.js";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered(fallback: ModelListing = { ok: true, models: ["grok-4.7"] }) {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string }[] = [];
  const ctx = {
    namespace: "xai",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string }) => (listed.push(endpoint), fallback)
    }
  };
  await (xai as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

/** xAI's API as `fetch` sees it: what each request asked, answered with `reply`. */
function serve(reply: (url: string) => Response) {
  const asked: { url: string; auth: string | null; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), signal: init?.signal });
    return reply(String(url));
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });

it("registers a provider with the xAI Grok preset at api.x.ai, starting on grok-4.7", async () => {
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "xai", title: { en: "xAI (Grok)", zh: "xAI（Grok）" }, baseURL: { default: API } });
  expect(API).toBe("https://api.x.ai/v1");
  expect(spec.presets!.map((p) => [p.id, p.title, p.baseURL, p.model, p.env, p.keyPage])).toEqual([
    ["xai", "xAI Grok", API, "grok-4.7", "XAI_API_KEY", "https://console.x.ai/team/default/api-keys"]
  ]);
  const preset = spec.presets![0]!;
  expect(preset.keyShapes!.some((shape) => shape.test("xai-AbC123"))).toBe(true);
  expect(preset.keyShapes!.some((shape) => shape.test("sk-AbC123"))).toBe(false);
  // without grok-4.7 listed, the newest numbered Grok; grok-4.20 is older than grok-4.3
  expect(["grok-4.20-0309-reasoning", "grok-4.20", "grok-4.3", "grok-4.6", "grok-build-0.1", "grok-5"].filter((id) => preset.prefer!.some((p) => p.test(id)))).toEqual(["grok-4.3", "grok-4.6", "grok-5"]);
  expect(preset.hint).toEqual({ en: expect.any(String), zh: expect.any(String) });
});

it("lists the chat models from /language-models with the key, and which of them read pictures", async () => {
  const asked = serve(() =>
    Response.json({
      models: [
        { id: "grok-4.7", aliases: ["grok-latest"], input_modalities: ["text", "image"], output_modalities: ["text"] },
        { id: "grok-4.20-0309-non-reasoning", aliases: [], input_modalities: ["text"], output_modalities: ["text"] },
        { id: "grok-build-0.1", aliases: [] }
      ]
    })
  );
  const { spec, listed } = await registered();
  const signal = new AbortController().signal;
  expect(await spec.list({ apiKey: "xai-k" }, signal)).toEqual({
    ok: true,
    models: ["grok-4.7", "grok-4.20-0309-non-reasoning", "grok-build-0.1"],
    capabilities: {
      "grok-4.7": { inputModalities: ["image"], outputModalities: [] },
      "grok-4.20-0309-non-reasoning": { inputModalities: [], outputModalities: [] }
    }
  });
  expect(asked).toEqual([{ url: `${API}/language-models`, auth: "Bearer xai-k", signal }]);
  expect(listed).toEqual([]);
});

it("falls back to the app's /models listing where the address has no /language-models, and says why a key fails", async () => {
  serve(() => new Response("not found", { status: 404 }));
  const { spec, listed } = await registered({ ok: true, models: ["grok-4.7", "grok-imagine-image"] });
  expect(await spec.list({ baseURL: "https://proxy.example/v1/", apiKey: "xai-p" }, new AbortController().signal)).toEqual({ ok: true, models: ["grok-4.7", "grok-imagine-image"] });
  expect(listed).toEqual([{ baseURL: "https://proxy.example/v1/", apiKey: "xai-p" }]);
  // that listing names no media, so the provider knows Grok 4.x reads pictures
  expect(spec.capabilities!("grok-4.7")).toEqual({ inputModalities: ["image"], outputModalities: [] });

  serve(() => new Response('{"error":"Incorrect API key provided"}', { status: 401 }));
  expect(await spec.list({ apiKey: "xai-bad" }, new AbortController().signal)).toEqual({ ok: false, status: 401, detail: '401 {"error":"Incorrect API key provided"}' });
  expect(listed).toHaveLength(1);
});

it("builds on the app's adapter, searching on the Responses API for Grok 4.x and later", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "xai", apiKey: "xai-a", model: "grok-4.7", inputModalities: ["image"] });
  spec.build({ id: "b", title: "", provider: "xai", baseURL: "https://proxy.example/v1", apiKey: "xai-b", model: "grok-build-0.1" });
  expect(built[0]).toMatchObject({ baseURL: API, apiKey: "xai-a", model: "grok-4.7", inputModalities: ["image"], webSearch: "responses" });
  expect(built[1]).toMatchObject({ baseURL: "https://proxy.example/v1", model: "grok-build-0.1" });
  expect(built[1]).not.toHaveProperty("webSearch");
  expect(built[0]!.body!({ model: "grok-4.7", max_tokens: 800, reasoning_effort: "minimal" }, request({ maxTokens: 800, effort: "minimal" }))).toEqual({ model: "grok-4.7", max_completion_tokens: 800, reasoning_effort: "low" });
});

it("shapes chat/completions: max_completion_tokens, and an effort the model takes", () => {
  expect(shape("grok-4.7", { model: "grok-4.7", max_tokens: 100 })).toEqual({ model: "grok-4.7", max_completion_tokens: 100 });
  expect(shape("grok-4.7", { reasoning_effort: "minimal" })).toEqual({ reasoning_effort: "low" });
  expect(shape("grok-4.3", { reasoning_effort: "medium" })).toEqual({ reasoning_effort: "medium" });
  expect(shape("grok-4.20-0309-non-reasoning", { reasoning_effort: "high", max_tokens: 5 })).toEqual({ max_completion_tokens: 5 });
  expect(shape("grok-4.7", { model: "grok-4.7", stream: true, tools: [] })).toEqual({ model: "grok-4.7", stream: true, tools: [] });
});

it("shapes the Responses body too: Grok's effort under reasoning, none for the non-reasoning models", () => {
  expect(answer("grok-4.7", { model: "grok-4.7", reasoning: { effort: "minimal" }, max_output_tokens: 9 })).toEqual({ model: "grok-4.7", reasoning: { effort: "low" }, max_output_tokens: 9 });
  expect(answer("grok-4.3", { reasoning: { effort: "high" } })).toEqual({ reasoning: { effort: "high" } });
  expect(answer("grok-4.20-0309-non-reasoning", { reasoning: { effort: "low" }, store: false })).toEqual({ store: false });
});

it("knows which models search, which read pictures, and which of a listing are chat models", () => {
  expect(["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-5", "grok-5.1-mini"].every(searches)).toBe(true);
  expect(["grok-build-0.1", "grok-4-0709", "grok-4-1-fast-reasoning", "grok-3", "grok-code-fast-1"].some(searches)).toBe(false);
  expect(media("grok-4.7")).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(media("grok-build-0.1")).toBeUndefined();
  expect(media("grok-4.7", { inputModalities: [], outputModalities: [] })).toEqual({ inputModalities: [], outputModalities: [] });
  expect(
    usable(["grok-4.20-0309-reasoning", "grok-4.3", "grok-imagine-image", "grok-4.20-multi-agent-0309", "grok-4.7", "grok-build-0.1", "grok-imagine-video-1.5", "grok-voice-3.0", "grok-4.6", "grok-embedding-small", "grok-voice-transcribe-2.0"])
  ).toEqual(["grok-4.7", "grok-4.6", "grok-4.3", "grok-4.20-0309-reasoning", "grok-build-0.1"]);
});
