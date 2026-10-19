import { crc32 } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelChatEvent, ModelChatRequest, ModelProviderSpec } from "@tomradex/plugin-sdk";
import bedrock from "../src/index.js";
import { address, chatModels, listModels, regionOf, usable } from "../src/bedrock.js";
import { readConverse, toConverse } from "../src/converse.js";
import { cliCredentials, cliRegion } from "../src/credentials.js";
import { eventStream } from "../src/eventstream.js";
import { BedrockModel } from "../src/model.js";
import { sign } from "../src/sigv4.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** One event stream message as AWS encodes it, CRCs included. */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    bytes.push(n.length, ...n, 7, v.length >> 8, v.length & 255, ...v);
  }
  const p = enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const out = new Uint8Array(16 + bytes.length + p.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  view.setUint32(4, bytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(bytes, 12);
  out.set(p, 12 + bytes.length);
  view.setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)));
  return out;
}

const event = (type: string, payload: unknown) => frame({ ":event-type": type, ":content-type": "application/json", ":message-type": "event" }, payload);

async function* chunks(...parts: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function collect(events: AsyncIterable<ModelChatEvent>): Promise<ModelChatEvent[]> {
  const out: ModelChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...patch });

it("signs as AWS's SigV4 test suite does, and escapes a path segment twice", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const at = new Date("2015-08-30T12:36:00Z");
  const scope = { region: "us-east-1", service: "service" };
  expect(sign({ method: "GET", url: "https://example.amazonaws.com/" }, creds, scope, at).authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  );
  expect(sign({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1" }, creds, scope, at).authorization).toMatch(/Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  const session = sign({ method: "POST", url: "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-v1%3A0/converse-stream", headers: { "content-type": "application/json" }, body: "{}" }, { ...creds, sessionToken: "tok" }, { region: "us-west-2", service: "bedrock" }, at);
  expect(session).toMatchObject({ "content-type": "application/json", "x-amz-date": "20150830T123600Z", "x-amz-security-token": "tok" });
  expect(session.authorization).toMatch(/Credential=AKIDEXAMPLE\/20150830\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
});

it("reads event stream messages split anywhere across chunks", async () => {
  const a = event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hel" } });
  const b = event("messageStop", { stopReason: "end_turn" });
  const all = new Uint8Array([...a, ...b]);
  const got: string[] = [];
  for await (const m of eventStream(chunks(all.subarray(0, 5), all.subarray(5, a.length + 3), all.subarray(a.length + 3)))) got.push(`${m.headers[":event-type"]} ${new TextDecoder().decode(m.payload)}`);
  expect(got).toEqual(['contentBlockDelta {"contentBlockIndex":0,"delta":{"text":"Hel"}}', 'messageStop {"stopReason":"end_turn"}']);
});

it("maps a conversation to Converse: cache point, media, tool calls and results, turns of one role merged", () => {
  const body = toConverse(
    "global.anthropic.claude-sonnet-5-5",
    {
      system: "Be brief.",
      temperature: 0.2,
      effort: "minimal",
      tools: [{ name: "add", description: "Adds", inputSchema: { type: "object" } }],
      toolChoice: { name: "add" },
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "media", media: { mime: "image/png", base64: "AAA", name: "a.png" } }, { type: "media", media: { mime: "application/pdf", base64: "BBB", name: "Q3 report (final).pdf" } }] },
        { role: "assistant", content: [{ type: "text", text: "adding" }, { type: "tool_call", id: "t1", name: "add", args: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", id: "t1", content: "2" }] },
        { role: "user", content: [{ type: "text", text: "and?" }] }
      ]
    },
    { provider: "bedrock", effort: true }
  );
  expect(body).toEqual({
    system: [{ text: "Be brief." }, { cachePoint: { type: "default" } }],
    messages: [
      { role: "user", content: [{ text: "look" }, { image: { format: "png", source: { bytes: "AAA" } } }, { document: { format: "pdf", name: "Q3 report (final)", source: { bytes: "BBB" } } }] },
      { role: "assistant", content: [{ text: "adding" }, { toolUse: { toolUseId: "t1", name: "add", input: { a: 1 } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "2" }] } }, { text: "and?" }] }
    ],
    // Claude gets room to think and no temperature
    inferenceConfig: { maxTokens: 32000 },
    toolConfig: { tools: [{ toolSpec: { name: "add", description: "Adds", inputSchema: { json: { type: "object" } } } }], toolChoice: { tool: { name: "add" } } },
    additionalModelRequestFields: { output_config: { effort: "low" } }
  });
});

it("keeps other models' temperature, declares tools a past turn called, and gives no effort where Claude does not take one", () => {
  const history: ModelChatRequest["messages"] = [
    { role: "user", content: [{ type: "text", text: "go" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "search", args: {} }] },
    { role: "user", content: [{ type: "tool_result", id: "t1", content: "" }] }
  ];
  const body = toConverse("deepseek.v3.2", { system: "", messages: history, temperature: 0.3, effort: "high", toolChoice: "none" }, { provider: "bedrock", effort: true });
  expect(body).toEqual({
    messages: [history[0] && { role: "user", content: [{ text: "go" }] }, { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "search", input: {} } }] }, { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "(empty)" }] } }] }],
    inferenceConfig: { temperature: 0.3 },
    toolConfig: { tools: [{ toolSpec: { name: "search", description: "search", inputSchema: { json: { type: "object" } } } }] }
  });
  expect(toConverse("anthropic.claude-sonnet-4-5-20250929-v1:0", request({ effort: "high" }), { provider: "bedrock", effort: true })).not.toHaveProperty("additionalModelRequestFields");
  expect(toConverse("global.anthropic.claude-opus-5-5", request({ effort: "high" }), { provider: "bedrock", effort: false })).not.toHaveProperty("additionalModelRequestFields");
});

it("streams text and tool calls, counts cached tokens, and keeps Claude's signed reasoning for the next request of the turn", async () => {
  const stream = chunks(
    event("messageStart", { role: "assistant" }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "think" } } }),
    event("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig" } } }),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Let me add." } }),
    event("contentBlockStop", { contentBlockIndex: 1 }),
    event("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tu1", name: "add" } } }),
    event("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"a":2,' } } }),
    event("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '"b":3}' } } }),
    event("contentBlockStop", { contentBlockIndex: 2 }),
    event("messageStop", { stopReason: "tool_use" }),
    event("metadata", { usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheWriteInputTokens: 7 } })
  );
  const events = await collect(readConverse(stream, "bedrock"));
  const written = [
    { reasoningContent: { reasoningText: { text: "think", signature: "sig" } } },
    { text: "Let me add." },
    { toolUse: { toolUseId: "tu1", name: "add", input: { a: 2, b: 3 } } }
  ];
  expect(events).toEqual([
    { type: "text", delta: "Let me add." },
    { type: "tool_call", id: "tu1", name: "add", args: { a: 2, b: 3 } },
    { type: "usage", inputTokens: 117, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 7 },
    { type: "native", provider: "bedrock", data: written },
    { type: "stop", reason: "tool_use" }
  ]);
  // the next request of the turn sends the assistant's blocks as Bedrock wrote them
  const next = toConverse(
    "global.anthropic.claude-sonnet-5-5",
    {
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "add" }] },
        { role: "assistant", content: [{ type: "native", provider: "bedrock", data: written }, { type: "text", text: "Let me add." }, { type: "tool_call", id: "tu1", name: "add", args: { a: 2, b: 3 } }] },
        { role: "user", content: [{ type: "tool_result", id: "tu1", content: "5" }] }
      ]
    },
    { provider: "bedrock" }
  );
  expect((next.messages as { content: unknown[] }[])[1]!.content).toEqual(written);
});

it("ends on a mid-stream exception with what Bedrock said, and reads refusals and limits as stops", async () => {
  const exception = frame({ ":exception-type": "throttlingException", ":content-type": "application/json", ":message-type": "exception" }, { message: "Too many tokens" });
  await expect(collect(readConverse(chunks(event("messageStart", { role: "assistant" }), exception), "bedrock"))).rejects.toThrow("Bedrock throttlingException: Too many tokens");
  const stops = async (reason: string) => (await collect(readConverse(chunks(event("messageStop", { stopReason: reason })), "bedrock"))).at(-1);
  expect(await stops("max_tokens")).toEqual({ type: "stop", reason: "max_tokens" });
  expect(await stops("guardrail_intervened")).toEqual({ type: "stop", reason: "refusal" });
  expect(await stops("end_turn")).toEqual({ type: "stop", reason: "end" });
});

const FOUNDATION = [
  { modelId: "anthropic.claude-sonnet-5-5", inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"], responseStreamingSupported: true, inferenceTypesSupported: ["INFERENCE_PROFILE"], modelLifecycle: { status: "ACTIVE" } },
  { modelId: "deepseek.v3.2", inputModalities: ["TEXT"], outputModalities: ["TEXT"], responseStreamingSupported: true, inferenceTypesSupported: ["ON_DEMAND"], modelLifecycle: { status: "ACTIVE" } },
  { modelId: "mistral.ministral-3-8b-instruct", inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"], responseStreamingSupported: true, inferenceTypesSupported: ["ON_DEMAND"], modelLifecycle: { status: "ACTIVE" } },
  { modelId: "openai.gpt-oss-safeguard-20b", inputModalities: ["TEXT"], outputModalities: ["TEXT"], responseStreamingSupported: true, inferenceTypesSupported: ["ON_DEMAND"], modelLifecycle: { status: "ACTIVE" } },
  { modelId: "anthropic.claude-3-haiku-20240307-v1:0", inputModalities: ["TEXT", "IMAGE"], outputModalities: ["TEXT"], responseStreamingSupported: true, inferenceTypesSupported: ["ON_DEMAND"], modelLifecycle: { status: "LEGACY" } }
];
const PROFILES = [
  { inferenceProfileId: "global.anthropic.claude-sonnet-5-5", status: "ACTIVE", models: [{ modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5-5" }] },
  { inferenceProfileId: "us.anthropic.claude-sonnet-5-5", status: "ACTIVE", models: [{ modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5-5" }] },
  { inferenceProfileId: "global.cohere.embed-v4:0", status: "ACTIVE", models: [{ modelArn: "arn:aws:bedrock:us-west-2::foundation-model/cohere.embed-v4:0" }] }
];

it("offers on-demand models by id and cross-region ones by their profiles, Claude first", () => {
  const { models, capabilities } = chatModels(FOUNDATION, PROFILES);
  expect(models.sort()).toEqual(["deepseek.v3.2", "global.anthropic.claude-sonnet-5-5", "mistral.ministral-3-8b-instruct", "us.anthropic.claude-sonnet-5-5"]);
  expect(capabilities["global.anthropic.claude-sonnet-5-5"]).toEqual({ inputModalities: ["image", "pdf"], outputModalities: [] });
  expect(capabilities["mistral.ministral-3-8b-instruct"]).toEqual({ inputModalities: ["image"], outputModalities: [] });
  expect(capabilities).not.toHaveProperty("deepseek.v3.2");
  expect(usable([...models, "global.anthropic.claude-opus-5-5", "amazon.nova-pro-v1:0", "anthropic.claude-sonnet-4-6"])).toEqual([
    "global.anthropic.claude-sonnet-5-5",
    "us.anthropic.claude-sonnet-5-5",
    "anthropic.claude-sonnet-4-6",
    "global.anthropic.claude-opus-5-5",
    "amazon.nova-pro-v1:0",
    "deepseek.v3.2",
    "mistral.ministral-3-8b-instruct"
  ]);
});

it("takes a region for the address and reads the region back from it", () => {
  expect(address("eu-central-1", "x")).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
  expect(address("", "https://bedrock-runtime.us-east-1.amazonaws.com")).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  expect(address("bedrock-runtime.ap-southeast-2.amazonaws.com/", "x")).toBe("https://bedrock-runtime.ap-southeast-2.amazonaws.com");
  expect(regionOf("https://bedrock-runtime.ap-southeast-2.amazonaws.com")).toBe("ap-southeast-2");
  expect(regionOf("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com")).toBe("us-gov-west-1");
});

it("lists through the control plane with the key or signed with the CLI's credentials, and leaves the listing empty when only listing is denied", async () => {
  const seen: { url: string; auth: string | null; token: string | null }[] = [];
  let deny = false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization"), token: headers.get("x-amz-security-token") });
    if (deny) return new Response('{"message":"not allowed"}', { status: 403, headers: { "x-amzn-errortype": "AccessDeniedException:http://internal.amazon.com/" } });
    if (url.includes("/foundation-models")) return new Response(JSON.stringify({ modelSummaries: FOUNDATION }));
    return new Response(JSON.stringify({ inferenceProfileSummaries: PROFILES }));
  });
  const base = "https://bedrock-runtime.us-west-2.amazonaws.com";
  const signal = new AbortController().signal;
  const keyed = await listModels(base, { apiKey: "ABSKkey", credentials: async () => { throw new Error("not used"); } }, signal);
  expect(keyed.ok && keyed.models?.includes("global.anthropic.claude-sonnet-5-5")).toBe(true);
  expect(seen.map((s) => [s.url, s.auth])).toEqual([
    ["https://bedrock.us-west-2.amazonaws.com/foundation-models?byOutputModality=TEXT", "Bearer ABSKkey"],
    ["https://bedrock.us-west-2.amazonaws.com/inference-profiles?maxResults=1000&type=SYSTEM_DEFINED", "Bearer ABSKkey"]
  ]);
  seen.length = 0;
  const signed = await listModels(base, { apiKey: "", credentials: async () => ({ accessKeyId: "AKID", secretAccessKey: "secret", sessionToken: "tok" }) }, signal);
  expect(signed.ok).toBe(true);
  expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=/);
  expect(seen[0]!.token).toBe("tok");
  deny = true;
  expect(await listModels(base, { apiKey: "ABSKkey", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }) }, signal)).toEqual({ ok: true, models: null });
  const broken = await listModels(base, { apiKey: "", credentials: async () => { throw new Error("the AWS CLI is not installed"); } }, signal);
  expect(broken).toEqual({ ok: false, detail: "the AWS CLI is not installed" });
});

it("retries throttling before anything streams, asks again without an effort Claude refused, and signs each try", async () => {
  const tries: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const plan = [429, 400, 200];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    tries.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    const status = plan.shift();
    if (status === 429) return new Response('{"message":"slow down"}', { status: 429 });
    if (status === 403) return new Response('{"message":"The security token included in the request is invalid."}', { status: 403, headers: { "x-amzn-errortype": "UnrecognizedClientException:" } });
    if (status === 400) return new Response('{"message":"output_config.effort: Extra inputs are not permitted"}', { status: 400, headers: { "x-amzn-errortype": "ValidationException:" } });
    return new Response(new Blob([event("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "ok" } }), event("messageStop", { stopReason: "end_turn" })] as BlobPart[]).stream());
  });
  const model = new BedrockModel({ baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com", apiKey: "", credentials: async () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }), model: "us.anthropic.claude-opus-5-5-v1:0", provider: "bedrock", retryDelayMs: 1 });
  const events = await collect(model.chat(request({ effort: "high" })));
  expect(events).toEqual([{ type: "retry", attempt: 1, max: 2, reason: "HTTP 429", delayMs: 1 }, { type: "text", delta: "ok" }, { type: "stop", reason: "end" }]);
  expect(tries[0]!.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-opus-5-5-v1%3A0/converse-stream");
  expect(tries.map((t) => !!t.body.additionalModelRequestFields)).toEqual([true, true, false]);
  expect(tries.every((t) => t.auth?.startsWith("AWS4-HMAC-SHA256 "))).toBe(true);
  plan.push(403);
  await expect(collect(model.chat(request()))).rejects.toThrow("Bedrock request failed 403 UnrecognizedClientException: The security token included in the request is invalid.");
});

it("refuses media the profile does not read", async () => {
  const model = new BedrockModel({ baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com", apiKey: "k", credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }), model: "deepseek.v3.2", provider: "bedrock" });
  await expect(collect(model.chat(request({ messages: [{ role: "user", content: [{ type: "media", media: { mime: "image/png", base64: "A", name: "a.png" } }] }] })))).rejects.toThrow("does not accept image/png");
});

it("holds the CLI's credentials until shortly before they expire, and reads the region from the environment first", async () => {
  let runs = 0;
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const credentials = cliCredentials(async (args) => {
    runs += 1;
    expect(args).toEqual(["configure", "export-credentials", "--format", "process"]);
    return JSON.stringify({ Version: 1, AccessKeyId: "AKID", SecretAccessKey: "s", SessionToken: "t", Expiration: later });
  });
  const [a, b] = await Promise.all([credentials(), credentials()]);
  expect(a).toEqual({ accessKeyId: "AKID", secretAccessKey: "s", sessionToken: "t" });
  expect(b).toBe(a);
  await credentials();
  expect(runs).toBe(1);
  await expect(cliCredentials(async () => "{}")()).rejects.toThrow(/no credentials/);
  vi.stubEnv("AWS_REGION", "eu-west-3");
  expect(await cliRegion(async () => "us-west-2")).toBe("eu-west-3");
  vi.stubEnv("AWS_REGION", "");
  vi.stubEnv("AWS_DEFAULT_REGION", "");
  expect(await cliRegion(async () => "us-west-2")).toBe("us-west-2");
  expect(await cliRegion(async () => { throw new Error("no aws"); })).toBeNull();
});

it("registers a provider that needs no key, on the region the person works in", async () => {
  vi.stubEnv("AWS_REGION", "ap-southeast-2");
  let spec: ModelProviderSpec | null = null;
  await (bedrock as unknown as { apply(ctx: unknown): Promise<void> }).apply({ namespace: "bedrock", models: { registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}) } });
  expect(spec).toMatchObject({ id: "bedrock", keyRequired: false, baseURL: { default: "https://bedrock-runtime.ap-southeast-2.amazonaws.com" } });
  expect(spec!.presets!.map((p) => [p.id, p.local ?? false, p.env])).toEqual([["bedrock", true, undefined], ["bedrock-key", false, "AWS_BEARER_TOKEN_BEDROCK"]]);
  const model = spec!.build({ id: "b", title: "", provider: "bedrock", apiKey: "", model: "global.anthropic.claude-sonnet-5-5", inputModalities: ["image", "pdf"] });
  expect(model.capabilities).toMatchObject({ tools: true, nativeWebSearch: false, mediaInput: ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"] });
});
