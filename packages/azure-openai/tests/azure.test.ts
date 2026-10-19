import { afterEach, expect, it, vi } from "vitest";
import type { CompatibleModelOptions, ModelProviderSpec } from "@tomradex/plugin-sdk";
import azure from "../src/index.js";
import { NO_ADDRESS, address, shape, usable } from "../src/azure.js";

const V1 = "https://myres.openai.azure.com/openai/v1";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered(endpoint?: string) {
  vi.stubEnv("AZURE_OPENAI_ENDPOINT", endpoint);
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const listed: { baseURL: string; apiKey: string; headers?: Record<string, string> }[] = [];
  const ctx = {
    namespace: "azure",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} }),
      listCompatible: async (endpoint: { baseURL: string; apiKey: string; headers?: Record<string, string> }) => (listed.push(endpoint), { ok: true as const, models: ["gpt-4o"] })
    }
  };
  await (azure as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built, listed };
}

const signal = () => new AbortController().signal;

afterEach(() => vi.unstubAllEnvs());

it("completes a resource name or any address on an Azure host to the resource's v1 API", () => {
  for (const input of ["myres", " MyRes ", "myres.openai.azure.com", "https://myres.openai.azure.com", "https://myres.openai.azure.com/", "https://myres.openai.azure.com/openai", "https://myres.openai.azure.com/openai/v1/", "https://myres.openai.azure.com/openai/v1?api-version=preview", "https://myres.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview"]) {
    expect(address(input), input).toBe(V1);
  }
  // a Foundry resource and an older Cognitive Services one keep their own host
  expect(address("https://myres.services.ai.azure.com/models")).toBe("https://myres.services.ai.azure.com/openai/v1");
  expect(address("https://myres.cognitiveservices.azure.com/")).toBe("https://myres.cognitiveservices.azure.com/openai/v1");
  // a gateway in front of the resource is used as typed
  expect(address("https://gw.example.com/azure/openai/v1/")).toBe("https://gw.example.com/azure/openai/v1");
  expect(address("")).toBe("");
  expect(address(undefined)).toBe("");
});

it("registers a provider with no address of its own and one preset whose key is offered once an endpoint is exported", async () => {
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "azure-openai", title: { en: "Azure OpenAI", zh: "Azure OpenAI" }, baseURL: { default: "" } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([["azure-openai", "", "", undefined]]);

  const exported = await registered("https://myres.openai.azure.com/");
  expect(exported.spec.baseURL).toEqual({ default: V1 });
  expect(exported.spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.env])).toEqual([["azure-openai", V1, "", "AZURE_OPENAI_API_KEY"]]);
});

it("checks the key by listing the resource's models with it in api-key, and asks for an address without one", async () => {
  const { spec, listed } = await registered();
  expect(await spec.list({ apiKey: "k1" }, signal())).toEqual({ ok: false, detail: NO_ADDRESS });
  expect(listed).toEqual([]);
  await spec.list({ baseURL: "myres", apiKey: "k1" }, signal());
  await spec.list({ baseURL: "https://other.services.ai.azure.com", apiKey: "k2" }, signal());
  expect(listed).toEqual([
    { baseURL: V1, apiKey: "k1", headers: { "api-key": "k1" } },
    { baseURL: "https://other.services.ai.azure.com/openai/v1", apiKey: "k2", headers: { "api-key": "k2" } }
  ]);

  // a profile without an address of its own talks to the exported one
  const exported = await registered("myres");
  await exported.spec.list({ apiKey: "k3" }, signal());
  expect(exported.listed).toEqual([{ baseURL: V1, apiKey: "k3", headers: { "api-key": "k3" } }]);
});

it("builds on the app's adapter at the completed address, the key in api-key, searching on the Responses API", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "azure-openai", baseURL: "https://myres.openai.azure.com/", apiKey: "k1", model: "my-gpt-5" });
  expect(built[0]).toMatchObject({ baseURL: V1, apiKey: "k1", model: "my-gpt-5", webSearch: "responses" });
  expect(await built[0]!.headers!({ url: `${V1}/chat/completions`, body: "{}" })).toEqual({ "api-key": "k1" });
  expect(built[0]!.body!({ model: "my-gpt-5", max_tokens: 64, reasoning_effort: "low" }, { system: "", messages: [] })).toEqual({ model: "my-gpt-5", max_completion_tokens: 64, reasoning_effort: "low" });
});

it("sends max_completion_tokens in place of max_tokens, and keeps the chat models of a listing", () => {
  expect(shape({ model: "o4-mini", max_tokens: 200, temperature: 0 })).toEqual({ model: "o4-mini", max_completion_tokens: 200, temperature: 0 });
  // a body that already carries the new name, or no limit, is left as it is
  expect(shape({ model: "gpt-4o", max_completion_tokens: 50 })).toEqual({ model: "gpt-4o", max_completion_tokens: 50 });
  expect(shape({ model: "gpt-4o" })).toEqual({ model: "gpt-4o" });
  expect(
    usable(["gpt-5.6", "gpt-4.1-mini", "o4-mini", "text-embedding-3-large", "tts-hd", "whisper", "gpt-4o-transcribe", "dall-e-3", "gpt-image-1", "sora", "text-moderation-latest", "gpt-realtime", "davinci-002", "babbage-002", "gpt-4o-mini.ft-abc123", "DeepSeek-V3.1"])
  ).toEqual(["gpt-5.6", "gpt-4.1-mini", "o4-mini", "gpt-4o-mini.ft-abc123", "DeepSeek-V3.1"]);
});
