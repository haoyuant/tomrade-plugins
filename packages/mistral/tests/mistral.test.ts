import { afterEach, expect, it, vi } from "vitest";
import type { CompatibleModelOptions, ModelChatRequest, ModelProviderSpec } from "@tomradex/plugin-sdk";
import mistral from "../src/index.js";
import { MISTRAL, chatModels, media, shape, toolIds } from "../src/mistral.js";

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered() {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const ctx = {
    namespace: "mistral",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} })
    }
  };
  await (mistral as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built };
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [], ...patch });

/** A card as `GET /v1/models` has it: a chat model that calls tools unless said otherwise. */
const card = (id: string, aliases: string[] = [], capabilities: Record<string, boolean> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  aliases,
  capabilities: { completion_chat: true, function_calling: true, vision: false, ...capabilities },
  deprecation: null,
  type: "base",
  ...extra
});

const LISTED = [
  card("mistral-medium-3-5", ["mistral-medium-3", "mistral-medium-latest"], { vision: true, reasoning: true }),
  card("mistral-medium-latest", ["mistral-medium-3-5", "mistral-medium-3"], { vision: true, reasoning: true }),
  card("mistral-medium-3", ["mistral-medium-3-5", "mistral-medium-latest"], { vision: true, reasoning: true }),
  card("mistral-large-4", ["mistral-large-4-0"], { vision: true, reasoning: true }),
  card("mistral-large-4-0", ["mistral-large-4"], { vision: true, reasoning: true }),
  card("mistral-large-latest", ["mistral-large-2512"], { vision: true }),
  card("mistral-large-2512", ["mistral-large-latest"], { vision: true }),
  card("mistral-small-latest", ["mistral-small-2603"], { vision: true, reasoning: true }),
  card("mistral-small-2603", ["mistral-small-latest"], { vision: true, reasoning: true }),
  card("codestral-2508", ["codestral-latest"], { completion_fim: true }),
  card("zai-glm-5-3", ["zai-glm-5", "zai-glm-latest"], { reasoning: true }),
  // deprecated by now, and one deprecated only next year
  card("magistral-medium-2509", ["magistral-medium-latest"], { vision: true, reasoning: true }, { deprecation: "2026-05-22T12:00:00Z" }),
  card("zai-glm-5-2", [], {}, { deprecation: "2026-09-29T12:00:00Z" }),
  card("ministral-8b-2512", ["ministral-8b-latest"], { vision: true }, { deprecation: "2027-01-31T12:00:00Z" }),
  // no chat, speech, no tools
  card("mistral-embed-2312", ["mistral-embed"], { completion_chat: false, function_calling: false }),
  card("mistral-ocr-2512", [], { completion_chat: false, ocr: true }),
  card("mistral-moderation-2603", [], { completion_chat: false, moderation: true }),
  card("voxtral-small-2507", ["voxtral-small-latest"], { audio: true }),
  card("open-mistral-nemo", [], { function_calling: false }),
  card("ft:mistral-small-2603:acme:20261001:a1b2c3d4", [], {}, { type: "fine-tuned", job: "j1", root: "mistral-small-2603" })
];

afterEach(() => vi.unstubAllGlobals());

it("registers a provider with one preset on La Plateforme that starts on Mistral Medium 3.5", async () => {
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "mistral", title: { en: "Mistral AI", zh: "Mistral AI" }, baseURL: { default: MISTRAL } });
  expect(spec.presets!.map((p) => [p.id, p.baseURL, p.model, p.keyPage, p.env, p.keyShapes])).toEqual([
    ["mistral", "https://api.mistral.ai/v1", "mistral-medium-3-5", "https://console.mistral.ai/api-keys", "MISTRAL_API_KEY", undefined]
  ]);
  expect(spec.presets![0]!.hint).toEqual({ en: expect.any(String), zh: expect.any(String) });
});

it("lists from Mistral's own GET /models with the key and the signal, keeping one name per chat model and what it reads", async () => {
  const asked: { url: string; auth: string | null; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    asked.push({ url, auth: new Headers(init.headers).get("authorization"), signal: init.signal });
    return new Response(JSON.stringify({ object: "list", data: LISTED.slice(0, 9) }), { headers: { "content-type": "application/json" } });
  });
  const { spec } = await registered();
  const signal = new AbortController().signal;
  const listed = await spec.list({ apiKey: "key-x" }, signal);
  await spec.list({ baseURL: "https://gateway.example.com/mistral/v1/", apiKey: "key-y" }, signal);
  expect(asked).toEqual([
    { url: "https://api.mistral.ai/v1/models", auth: "Bearer key-x", signal },
    { url: "https://gateway.example.com/mistral/v1/models", auth: "Bearer key-y", signal }
  ]);
  expect(listed).toEqual({
    ok: true,
    models: ["mistral-medium-3-5", "mistral-large-4-0", "mistral-large-2512", "mistral-small-2603"],
    capabilities: {
      "mistral-medium-3-5": { inputModalities: ["image"], outputModalities: [] },
      "mistral-large-4-0": { inputModalities: ["image"], outputModalities: [] },
      "mistral-large-2512": { inputModalities: ["image"], outputModalities: [] },
      "mistral-small-2603": { inputModalities: ["image"], outputModalities: [] }
    }
  });
});

it("says why a key is refused, and starts on the preset's model where the address has no listing", async () => {
  let status = 401;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status }));
  const { spec } = await registered();
  expect(await spec.list({ apiKey: "bad" }, new AbortController().signal)).toEqual({ ok: false, status: 401, detail: '401 {"detail":"Unauthorized"}' });
  status = 404;
  expect(await spec.list({ baseURL: "https://gateway.example.com/v1", apiKey: "k" }, new AbortController().signal)).toEqual({ ok: true, models: null });
});

it("keeps chat models that call tools and are not deprecated yet, fine-tuned ones included, under their most specific name", () => {
  const { models, capabilities } = chatModels(LISTED, Date.parse("2026-10-19T00:00:00Z"));
  expect(models).toEqual([
    "mistral-medium-3-5",
    "mistral-large-4-0",
    "mistral-large-2512",
    "mistral-small-2603",
    "codestral-2508",
    "zai-glm-5-3",
    "ministral-8b-2512",
    "ft:mistral-small-2603:acme:20261001:a1b2c3d4"
  ]);
  expect(Object.entries(capabilities).filter(([, m]) => m.inputModalities.includes("image")).map(([id]) => id)).toEqual(["mistral-medium-3-5", "mistral-large-4-0", "mistral-large-2512", "mistral-small-2603", "ministral-8b-2512"]);
  expect(capabilities["zai-glm-5-3"]).toEqual({ inputModalities: [], outputModalities: [] });
  // a model listed only under -latest keeps that name
  expect(chatModels([card("mistral-tiny-latest")]).models).toEqual(["mistral-tiny-latest"]);
});

it("knows which names read pictures when the listing does not say", () => {
  expect(["mistral-medium-latest", "mistral-large-latest", "mistral-small-2603", "ministral-14b-latest", "ministral-3b-2512"].map((m) => media(m))).toEqual(Array(5).fill({ inputModalities: ["image"], outputModalities: [] }));
  expect(["codestral-latest", "zai-glm-5-3", "ministral-8b-2410"].map((m) => media(m))).toEqual([undefined, undefined, undefined]);
  expect(media("mistral-medium-3-5", { inputModalities: [], outputModalities: [] })).toEqual({ inputModalities: [], outputModalities: [] });
});

it("builds on the app's adapter at the profile's address, with no output media and no search of its own", async () => {
  const { spec, built } = await registered();
  spec.build({ id: "a", title: "", provider: "mistral", apiKey: "key-a", model: "mistral-medium-3-5", inputModalities: ["image"], outputModalities: ["audio"] });
  spec.build({ id: "b", title: "", provider: "mistral", baseURL: "https://gateway.example.com/v1", apiKey: "key-b", model: "codestral-2508" });
  expect(built[0]).toMatchObject({ baseURL: MISTRAL, apiKey: "key-a", model: "mistral-medium-3-5", inputModalities: ["image"] });
  expect(built[1]).toMatchObject({ baseURL: "https://gateway.example.com/v1", model: "codestral-2508" });
  for (const options of built) {
    expect(options).not.toHaveProperty("outputModalities");
    expect(options).not.toHaveProperty("webSearch");
  }
  expect(built[0]!.body!({ model: "mistral-medium-3-5", stream: true, stream_options: { include_usage: true }, reasoning_effort: "high" }, request({ effort: "high" }))).toEqual({ model: "mistral-medium-3-5", stream: true, reasoning_effort: "high" });
  expect(built[1]!.body!({ model: "codestral-2508", reasoning_effort: "high" }, request({ effort: "high" }))).toEqual({ model: "codestral-2508" });
});

it("sends reasoning_effort, as Mistral names it, only to Medium 3.5, Large 4 and Small 4", () => {
  for (const model of ["mistral-medium-3-5", "mistral-medium-3", "mistral-medium-latest", "mistral-large-4", "mistral-large-4-0", "mistral-small-2603", "mistral-small-latest"]) {
    expect(shape(model, { reasoning_effort: "minimal" }), model).toEqual({ reasoning_effort: "minimal" });
  }
  for (const model of ["mistral-large-2512", "mistral-large-latest", "mistral-medium-2508", "mistral-small-2506", "ministral-14b-2512", "codestral-2508", "zai-glm-5-3", "ft:mistral-small-2603:acme:20261001:a1b2c3d4"]) {
    expect(shape(model, { reasoning_effort: "high" }), model).toEqual({});
  }
  expect(["low", "medium", "high", "off", "max", "xhigh"].map((effort) => shape("mistral-small-2603", { reasoning_effort: effort }).reasoning_effort)).toEqual(["low", "medium", "high", "none", "xhigh", "xhigh"]);
  expect(shape("mistral-small-2603", { reasoning_effort: "turbo" })).toEqual({});
});

it("sends only the fields Mistral's request schema has, the temperature within 0–1.5", () => {
  const tools = [{ type: "function", function: { name: "lookup", description: "", parameters: { type: "object" } } }];
  const body = {
    model: "mistral-medium-3-5",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hi" }],
    temperature: 2,
    max_completion_tokens: 512,
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "pcm16" },
    tools,
    tool_choice: { type: "function", function: { name: "lookup" } },
    response_format: { type: "json_object" }
  };
  expect(shape("mistral-medium-3-5", body)).toEqual({
    model: "mistral-medium-3-5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    temperature: 1.5,
    max_tokens: 512,
    tools,
    tool_choice: { type: "function", function: { name: "lookup" } },
    response_format: { type: "json_object" }
  });
  expect(shape("x", { temperature: -1, max_tokens: 100, max_completion_tokens: 512 })).toEqual({ temperature: 0, max_tokens: 100 });
  expect(shape("x", { temperature: 0.7, tool_choice: "none" })).toEqual({ temperature: 0.7, tool_choice: "none" });
});

it("gives another provider's tool-call ids nine letters and digits, the same in the call and its result, and keeps Mistral's", () => {
  const call = (id: string, name = "lookup") => ({ id, type: "function", function: { name, arguments: "{}" } });
  const messages = [
    { role: "system", content: "" },
    { role: "user", content: "look it up" },
    { role: "assistant", content: null, tool_calls: [call("call_Q8tX2bLm0pVr7sYw"), call("toolu_01AbCdEfGhIjKlMn", "search")] },
    { role: "tool", tool_call_id: "call_Q8tX2bLm0pVr7sYw", content: "one" },
    { role: "tool", tool_call_id: "toolu_01AbCdEfGhIjKlMn", content: "two" },
    { role: "assistant", content: null, tool_calls: [call("D681PevKs")] },
    { role: "tool", tool_call_id: "D681PevKs", content: "three" }
  ];
  const before = structuredClone(messages);
  const out = shape("mistral-medium-3-5", { messages }).messages as typeof messages;
  const [first, second] = out[2]!.tool_calls!.map((c) => c.id);
  expect(first).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(second).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(first).not.toBe(second);
  expect([out[3]!.tool_call_id, out[4]!.tool_call_id]).toEqual([first, second]);
  expect(out[2]!.tool_calls![0]!.function).toEqual({ name: "lookup", arguments: "{}" });
  expect([out[5]!.tool_calls![0]!.id, out[6]!.tool_call_id]).toEqual(["D681PevKs", "D681PevKs"]);
  expect(out.slice(0, 2)).toEqual(messages.slice(0, 2));
  expect(messages).toEqual(before);

  // the next request, one turn longer, names the earlier calls the same way
  const later = toolIds([...messages, { role: "user", content: "and again" }, { role: "assistant", content: null, tool_calls: [call("call_0")] }, { role: "tool", tool_call_id: "call_0", content: "four" }]);
  expect(later.slice(0, 7)).toEqual(out);
  expect(later[8]!.tool_calls![0]!.id).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(later[9]!.tool_call_id).toBe(later[8]!.tool_calls![0]!.id);
});

it("never gives a foreign id one that another call in the request already has", () => {
  const made = toolIds([{ role: "tool", tool_call_id: "call_abc" }])[0]!.tool_call_id as string;
  // a Mistral id that happens to be the one the foreign id would get
  const out = toolIds([
    { role: "assistant", tool_calls: [{ id: made }, { id: "call_abc" }] },
    { role: "tool", tool_call_id: made },
    { role: "tool", tool_call_id: "call_abc" }
  ]);
  const ids = out[0]!.tool_calls!.map((c) => c.id);
  expect(ids[0]).toBe(made);
  expect(ids[1]).toMatch(/^[a-zA-Z0-9]{9}$/);
  expect(ids[1]).not.toBe(made);
  expect([out[1]!.tool_call_id, out[2]!.tool_call_id]).toEqual(ids);
});
