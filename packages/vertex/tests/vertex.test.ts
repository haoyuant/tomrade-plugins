import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CompatibleModelOptions, ModelChatEvent, ModelChatRequest, ModelProviderSpec } from "@tomradex/plugin-sdk";
import vertex from "../src/index.js";
import { adcPath, defaultProject, googleToken } from "../src/credentials.js";
import { UNSIGNED, readGemini, sseData, toGemini, type Part } from "../src/gemini.js";
import { GeminiModel } from "../src/model.js";
import { KEY_MODELS, MAAS, NO_PROJECT, address, authorize, listModels, locationOf, media, projectOf, usable } from "../src/vertex.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const BASE = "https://aiplatform.googleapis.com/v1/projects/my-project/locations/global";
const user = async () => ({ token: "ya29.user", user: true, quotaProject: "quota-project" });

async function collect(events: AsyncIterable<ModelChatEvent>): Promise<ModelChatEvent[]> {
  const out: ModelChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function* lines(...chunks: unknown[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield JSON.stringify(chunk);
}

const sse = (...chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const request = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...patch });

it("exchanges the ADC file's refresh token once, holds the token until shortly before it expires, and names its quota project", async () => {
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    posts.push({ url, body: String(init?.body) });
    return new Response(JSON.stringify({ access_token: "ya29.adc", expires_in: 3599, token_type: "Bearer" }));
  });
  const adc = { type: "authorized_user", client_id: "cid", client_secret: "secret", refresh_token: "1//refresh", quota_project_id: "quota-project" };
  const token = googleToken(async () => adc, async () => {
    throw new Error("gcloud is not asked while the ADC file works");
  });
  const [a, b] = await Promise.all([token(), token()]);
  expect(a).toEqual({ token: "ya29.adc", user: true, quotaProject: "quota-project" });
  expect(b).toBe(a);
  await token();
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("https://oauth2.googleapis.com/token");
  expect(Object.fromEntries(new URLSearchParams(posts[0]!.body))).toEqual({ grant_type: "refresh_token", client_id: "cid", client_secret: "secret", refresh_token: "1//refresh" });

  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }));
  await expect(googleToken(async () => adc)()).rejects.toThrow("Google turned down the Application Default Credentials (400 invalid_grant: Token has been expired or revoked.): run `gcloud auth application-default login` again");
});

it("falls back to gcloud's own credentials, renewed when the cached one is all but spent, a person's billed to their quota project", async () => {
  const runs: string[][] = [];
  let expiry = new Date(Date.now() + 2 * 60_000).toISOString();
  const token = googleToken(async () => ({ type: "service_account" }), async (args) => {
    runs.push(args);
    const out = JSON.stringify({ configuration: { properties: { core: { account: "me@example.com", project: "my-project" }, billing: { quota_project: "billed-project" } } }, credential: { access_token: `ya29.gcloud${runs.length}`, token_expiry: expiry } });
    expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    return out;
  });
  expect(await token()).toEqual({ token: "ya29.gcloud2", user: true, quotaProject: "billed-project" });
  expect(runs).toEqual([["config", "config-helper", "--format=json"], ["config", "config-helper", "--format=json", "--force-auth-refresh"]]);
  await token();
  expect(runs).toHaveLength(2);
  // a service account gcloud signed in with bills its own project
  const later = new Date(Date.now() + 60 * 60_000).toISOString();
  const robot = googleToken(async () => null, async () => JSON.stringify({ configuration: { properties: { core: { account: "ci@p.iam.gserviceaccount.com" }, billing: { quota_project: "billed-project" } } }, credential: { access_token: "ya29.sa", token_expiry: later } }));
  expect(await robot()).toEqual({ token: "ya29.sa", user: false });
  // no ADC file at all asks gcloud too, and says what to do when it has nothing
  await expect(googleToken(async () => null, async () => JSON.stringify({ configuration: {} }))()).rejects.toThrow(/gcloud has no credentials/);
  await expect(googleToken(async () => null, async () => { throw new Error("gcloud is not installed"); })()).rejects.toThrow("gcloud is not installed");
});

it("finds the ADC file where Google's libraries do, and the project the person works in", async () => {
  expect(adcPath({ GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" }, "darwin")).toBe("/keys/sa.json");
  expect(adcPath({ CLOUDSDK_CONFIG: "/cfg" }, "linux")).toBe("/cfg/application_default_credentials.json");
  expect(adcPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toMatch(/AppData.Roaming.gcloud.application_default_credentials\.json$/);
  expect(adcPath({}, "darwin")).toMatch(/\.config\/gcloud\/application_default_credentials\.json$/);

  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
  vi.stubEnv("CLOUDSDK_CORE_PROJECT", "");
  const adc = async () => ({ quota_project_id: "quota-project" });
  expect(await defaultProject(async (args) => (expect(args).toEqual(["config", "get-value", "project"]), "my-project"), adc)).toBe("my-project");
  expect(await defaultProject(async () => "(unset)", adc)).toBe("quota-project");
  expect(await defaultProject(async () => { throw new Error("no gcloud"); }, async () => null)).toBe("");
  vi.stubEnv("CLOUDSDK_CORE_PROJECT", "core-project");
  expect(await defaultProject(async () => "my-project", adc)).toBe("core-project");
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "env-project");
  expect(await defaultProject(async () => "my-project", adc)).toBe("env-project");
});

it("takes a full address, a resource path or a bare project id, and reads the project and location back", () => {
  expect(address("", BASE)).toBe(BASE);
  expect(address("other-project", BASE)).toBe("https://aiplatform.googleapis.com/v1/projects/other-project/locations/global");
  expect(address("projects/p-123456/locations/europe-west4", BASE)).toBe("https://europe-west4-aiplatform.googleapis.com/v1/projects/p-123456/locations/europe-west4");
  expect(address("https://us-central1-aiplatform.googleapis.com/v1/projects/p-123456/locations/us-central1/", BASE)).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/p-123456/locations/us-central1");
  expect(address("aiplatform.googleapis.com/v1/projects/p-123456/locations/global/publishers/google/models/gemini-3.8-flash", BASE)).toBe("https://aiplatform.googleapis.com/v1/projects/p-123456/locations/global");
  expect(projectOf("https://europe-west4-aiplatform.googleapis.com/v1/projects/p-123456/locations/europe-west4")).toBe("p-123456");
  expect(locationOf("https://europe-west4-aiplatform.googleapis.com/v1/projects/p-123456/locations/europe-west4")).toBe("europe-west4");
  // no project found: the default has an empty one, which the listing explains
  expect(projectOf("https://aiplatform.googleapis.com/v1/projects//locations/global")).toBe("");
});

it("lets requests in with an API key, a person's token billed to their quota project, or gcloud's token alone", async () => {
  expect(await authorize({ apiKey: " AQ.key ", token: user }, "my-project")).toEqual({ "x-goog-api-key": "AQ.key" });
  expect(await authorize({ apiKey: "", token: user }, "my-project")).toEqual({ authorization: "Bearer ya29.user", "x-goog-user-project": "quota-project" });
  expect(await authorize({ apiKey: "", token: async () => ({ token: "t", user: true }) }, "my-project")).toEqual({ authorization: "Bearer t", "x-goog-user-project": "my-project" });
  expect(await authorize({ apiKey: "", token: async () => ({ token: "t", user: false }) }, "my-project")).toEqual({ authorization: "Bearer t" });
});

it("maps a conversation to generateContent: system, media inline, tools by JSON Schema, results named after their calls, effort as a thinking level", () => {
  const body = toGemini(
    "gemini-3.8-flash",
    {
      system: "Be brief.",
      temperature: 0.2,
      maxTokens: 900,
      effort: "minimal",
      tools: [{ name: "add", description: "Adds", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { a: { type: "number" } }, additionalProperties: false } }],
      toolChoice: { name: "add" },
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "media", media: { mime: "image/png", base64: "AAA", name: "a.png" } }, { type: "media", media: { mime: "application/pdf", base64: "BBB", name: "b.pdf" } }] },
        { role: "assistant", content: [{ type: "text", text: "adding" }, { type: "tool_call", id: "t1", name: "add", args: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", id: "t1", content: "2" }] },
        { role: "user", content: [{ type: "text", text: "and?" }] }
      ]
    },
    { provider: "vertex", search: true, thinking: true }
  );
  expect(body).toEqual({
    contents: [
      { role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "AAA" } }, { inlineData: { mimeType: "application/pdf", data: "BBB" } }] },
      { role: "model", parts: [{ text: "adding" }, { functionCall: { name: "add", args: { a: 1 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "add", response: { output: "2" } } }, { text: "and?" }] }
    ],
    systemInstruction: { parts: [{ text: "Be brief." }] },
    // Google Search stays out beside functions, which Vertex refuses it with
    tools: [{ functionDeclarations: [{ name: "add", description: "Adds", parametersJsonSchema: { type: "object", properties: { a: { type: "number" } }, additionalProperties: false } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["add"] } },
    // Gemini 3 keeps its own temperature
    generationConfig: { maxOutputTokens: 900, thinkingConfig: { thinkingLevel: "LOW" } }
  });
  const level = (effort: string) => (toGemini("gemini-4-argon", request({ effort }), { provider: "vertex", search: false, thinking: true }).generationConfig as { thinkingConfig: { thinkingLevel: string } }).thinkingConfig.thinkingLevel;
  expect(["minimal", "low", "medium", "high", "xhigh"].map(level)).toEqual(["LOW", "LOW", "MEDIUM", "HIGH", "HIGH"]);
});

it("keeps an older Gemini's temperature and no thinking level, searches Google on a request without functions, and maps the other tool choices and JSON", () => {
  expect(toGemini("gemini-2.5-flash", request({ temperature: 0.3, effort: "high", json: true }), { provider: "vertex", search: false, thinking: true })).toEqual({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" }
  });
  expect(toGemini("gemini-3.8-flash", request({ webSearch: true }), { provider: "vertex", search: true, thinking: true }).tools).toEqual([{ googleSearch: {} }]);
  expect(toGemini("gemini-3.8-flash", request({ effort: "high" }), { provider: "vertex", search: false, thinking: false })).not.toHaveProperty("generationConfig");
  const tools = [{ name: "t", description: "", inputSchema: { type: "object" } }];
  expect(toGemini("gemini-3.8-flash", request({ tools, toolChoice: "none" }), { provider: "vertex", search: false, thinking: true }).toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
  expect(toGemini("gemini-3.8-flash", request({ tools, toolChoice: "auto" }), { provider: "vertex", search: false, thinking: true }).toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  expect(toGemini("gemini-3.8-flash", request({ tools }), { provider: "vertex", search: false, thinking: true })).not.toHaveProperty("toolConfig");
});

it("lets another model's calls of the current turn through Gemini 3's signature check, and marks a failed tool result as an error", () => {
  const body = toGemini(
    "gemini-3.8-flash",
    {
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "a", name: "read", args: {} }] },
        { role: "user", content: [{ type: "tool_result", id: "a", content: "x" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "now" }] },
        { role: "assistant", content: [{ type: "tool_call", id: "b", name: "write", args: { v: 1 } }, { type: "tool_call", id: "c", name: "read", args: {} }] },
        { role: "user", content: [{ type: "tool_result", id: "b", content: "denied", isError: true }, { type: "tool_result", id: "c", content: "y" }] }
      ]
    },
    { provider: "vertex", search: false, thinking: true }
  );
  const contents = body.contents as { role: string; parts: Part[] }[];
  expect(contents[1]!.parts).toEqual([{ functionCall: { name: "read", args: {} } }]);
  expect(contents[5]!.parts).toEqual([{ functionCall: { name: "write", args: { v: 1 } }, thoughtSignature: UNSIGNED }, { functionCall: { name: "read", args: {} } }]);
  expect(contents[6]!.parts).toEqual([{ functionResponse: { name: "write", response: { error: "denied" } } }, { functionResponse: { name: "read", response: { output: "y" } } }]);
});

it("streams text, hides thoughts, calls functions, and keeps Gemini's parts with their signatures for the next request of the turn", async () => {
  const events = await collect(
    readGemini(
      lines(
        { candidates: [{ content: { role: "model", parts: [{ text: "pondering", thought: true, thoughtSignature: "t-sig" }] } }], usageMetadata: { promptTokenCount: 10 } },
        { candidates: [{ content: { role: "model", parts: [{ text: "Let me " }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "add." }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "add", args: { a: 2, b: 3 } }, thoughtSignature: "call-sig" }, { functionCall: { name: "add", args: { a: 1, b: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 9, thoughtsTokenCount: 30, cachedContentTokenCount: 100 } }
      ),
      "vertex",
      (n) => `call_${n}`
    )
  );
  const written = [
    { text: "", thoughtSignature: "t-sig" },
    { text: "Let me add." },
    { functionCall: { name: "add", args: { a: 2, b: 3 } }, thoughtSignature: "call-sig" },
    { functionCall: { name: "add", args: { a: 1, b: 1 } } }
  ];
  expect(events).toEqual([
    { type: "text", delta: "Let me " },
    { type: "text", delta: "add." },
    { type: "tool_call", id: "call_1", name: "add", args: { a: 2, b: 3 } },
    { type: "tool_call", id: "call_2", name: "add", args: { a: 1, b: 1 } },
    // the prompt count already includes the cached tokens; thinking is output
    { type: "usage", inputTokens: 120, outputTokens: 39, cacheReadTokens: 100 },
    { type: "native", provider: "vertex", data: written },
    { type: "stop", reason: "tool_use" }
  ]);
  const next = toGemini(
    "gemini-3.8-flash",
    {
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "add" }] },
        { role: "assistant", content: [{ type: "native", provider: "vertex", data: written }, { type: "text", text: "Let me add." }, { type: "tool_call", id: "call_1", name: "add", args: { a: 2, b: 3 } }, { type: "tool_call", id: "call_2", name: "add", args: { a: 1, b: 1 } }] },
        { role: "user", content: [{ type: "tool_result", id: "call_1", content: "5" }, { type: "tool_result", id: "call_2", content: "2" }] }
      ]
    },
    { provider: "vertex", search: false, thinking: true }
  );
  const contents = next.contents as { role: string; parts: Part[] }[];
  expect(contents[1]).toEqual({ role: "model", parts: written });
  expect(contents[2]!.parts).toEqual([{ functionResponse: { name: "add", response: { output: "5" } } }, { functionResponse: { name: "add", response: { output: "2" } } }]);
});

it("passes the ids Gemini gives its calls back on their responses, and keeps a signature that ends the text", async () => {
  const events = await collect(readGemini(lines({ candidates: [{ content: { parts: [{ text: "Sure." }, { text: "", thoughtSignature: "end-sig" }, { functionCall: { id: "fc-9", name: "look", args: {} } }] }, finishReason: "STOP" }] }), "vertex"));
  const native = events.find((e) => e.type === "native");
  expect(native).toEqual({ type: "native", provider: "vertex", data: [{ text: "Sure.", thoughtSignature: "end-sig" }, { functionCall: { id: "fc-9", name: "look", args: {} } }] });
  expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", id: "fc-9", name: "look", args: {} });
  const next = toGemini(
    "gemini-3.8-flash",
    {
      system: "",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [native as { type: "native"; provider: string; data: unknown }, { type: "tool_call", id: "fc-9", name: "look", args: {} }] },
        { role: "user", content: [{ type: "tool_result", id: "fc-9", content: "seen" }] }
      ]
    },
    { provider: "vertex", search: false, thinking: true }
  );
  expect((next.contents as { parts: Part[] }[])[2]!.parts).toEqual([{ functionResponse: { name: "look", id: "fc-9", response: { output: "seen" } } }]);
});

it("lists the pages Google Search grounded the answer in after it", async () => {
  const events = await collect(
    readGemini(
      lines(
        { candidates: [{ content: { parts: [{ text: "It is sunny." }] } }] },
        {
          candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP", groundingMetadata: { webSearchQueries: ["weather"], groundingChunks: [{ web: { uri: "https://a.example/w", title: "a.example" } }, { web: { uri: "https://b.example/[x]", title: "B [news]" } }, { web: { uri: "https://a.example/w", title: "dup" } }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, toolUsePromptTokenCount: 50 }
        }
      ),
      "vertex"
    )
  );
  expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : ""))).toEqual(["It is sunny.", "\n\n- [a.example](https://a.example/w)\n- [B news](https://b.example/[x])"]);
  expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", inputTokens: 55, outputTokens: 4 });
  expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
});

it("reads limits and refusals as stops, a blocked prompt as a refusal, and fails on an error in the stream or a malformed call", async () => {
  const stop = async (...chunks: unknown[]) => (await collect(readGemini(lines(...chunks), "vertex"))).at(-1);
  expect(await stop({ candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }] })).toEqual({ type: "stop", reason: "max_tokens" });
  expect(await stop({ candidates: [{ finishReason: "SAFETY" }] })).toEqual({ type: "stop", reason: "refusal" });
  expect(await stop({ candidates: [{ finishReason: "PROHIBITED_CONTENT" }] })).toEqual({ type: "stop", reason: "refusal" });
  expect(await stop({ promptFeedback: { blockReason: "BLOCKLIST" } })).toEqual({ type: "stop", reason: "refusal" });
  await expect(stop({ error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } })).rejects.toThrow("Vertex AI INTERNAL: Internal error encountered.");
  await expect(stop({ candidates: [{ finishReason: "MALFORMED_FUNCTION_CALL", finishMessage: "Malformed function call: add(" }] })).rejects.toThrow("Vertex AI could not finish the reply (MALFORMED_FUNCTION_CALL: Malformed function call: add()");
});

it("reads server-sent events split anywhere across chunks", async () => {
  const text = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\ndata: {"c":3}';
  async function* parts() {
    const bytes = new TextEncoder().encode(text);
    for (const cut of [[0, 5], [5, 17], [17, bytes.length]] as const) yield bytes.subarray(...cut);
  }
  const got: string[] = [];
  for await (const line of sseData(parts())) got.push(line);
  expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

it("retries throttling and overload before anything streams, but not a quota the project does not have, and says what Google said", async () => {
  const tries: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const plan: (() => Response)[] = [
    () => new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted. Please try again later.", status: "RESOURCE_EXHAUSTED" } }), { status: 429 }),
    () => new Response("", { status: 503 }),
    () => sse({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] })
  ];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    tries.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return plan.shift()!();
  });
  const model = new GeminiModel({ baseURL: BASE, apiKey: "", token: user, model: "gemini-3.8-flash", provider: "vertex", retryDelayMs: 1 });
  const events = await collect(model.chat(request()));
  expect(events.filter((e) => e.type !== "native")).toEqual([
    { type: "retry", attempt: 1, max: 2, reason: "HTTP 429", delayMs: 1 },
    { type: "retry", attempt: 2, max: 2, reason: "HTTP 503", delayMs: 3 },
    { type: "text", delta: "ok" },
    { type: "stop", reason: "end" }
  ]);
  expect(tries[0]!.url).toBe(`${BASE}/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`);
  expect(tries[0]!.headers.get("authorization")).toBe("Bearer ya29.user");
  expect(tries[0]!.headers.get("x-goog-user-project")).toBe("quota-project");

  tries.length = 0;
  plan.push(() => new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded for metric: generate_content_requests, limit: 0", status: "RESOURCE_EXHAUSTED" } }), { status: 429 }));
  await expect(collect(model.chat(request()))).rejects.toThrow("Vertex AI request failed 429 RESOURCE_EXHAUSTED: Quota exceeded for metric: generate_content_requests, limit: 0");
  expect(tries).toHaveLength(1);
  plan.push(() => new Response(JSON.stringify([{ error: { code: 404, message: "Publisher Model `gemini-nope` was not found or your project does not have access to it.", status: "NOT_FOUND" } }]), { status: 404 }));
  await expect(collect(model.chat(request()))).rejects.toThrow("Vertex AI request failed 404 NOT_FOUND: Publisher Model `gemini-nope` was not found");
});

it("retries a dropped connection, and goes to the publisher path with an API key", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  let drop = true;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (drop) {
      drop = false;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }
    return sse({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
  });
  const model = new GeminiModel({ baseURL: BASE, apiKey: "AQ.key", token: async () => { throw new Error("no token with a key"); }, model: "google/gemini-3.8-flash", provider: "vertex", retryDelayMs: 1 });
  const events = await collect(model.chat(request()));
  expect(events[0]).toEqual({ type: "retry", attempt: 1, max: 2, reason: "ECONNRESET", delayMs: 1 });
  expect(seen[1]!.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
  expect(seen[1]!.headers.get("x-goog-api-key")).toBe("AQ.key");
  expect(seen[1]!.headers.get("authorization")).toBeNull();
});

it("never fails for a search the request asked for: refused, it goes again without it and is not asked again; a refused thinking level likewise", async () => {
  const bodies: Record<string, unknown>[] = [];
  const plan: (() => Response)[] = [
    () => new Response(JSON.stringify({ error: { code: 400, message: "Grounding with Google Search is not supported for this model.", status: "INVALID_ARGUMENT" } }), { status: 400 }),
    () => sse({ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }] }),
    () => sse({ candidates: [{ content: { parts: [{ text: "b" }] }, finishReason: "STOP" }] }),
    () => new Response(JSON.stringify({ error: { code: 400, message: "Thinking level MEDIUM is not supported by this model.", status: "INVALID_ARGUMENT" } }), { status: 400 }),
    () => sse({ candidates: [{ content: { parts: [{ text: "c" }] }, finishReason: "STOP" }] })
  ];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return plan.shift()!();
  });
  const model = new GeminiModel({ baseURL: BASE, apiKey: "", token: user, model: "gemini-3.8-flash", provider: "vertex", retryDelayMs: 1 });
  expect((await collect(model.chat(request({ webSearch: true })))).find((e) => e.type === "text")).toEqual({ type: "text", delta: "a" });
  await collect(model.chat(request({ webSearch: true })));
  expect(bodies.map((b) => !!b.tools)).toEqual([true, false, false]);
  expect(model.capabilities.nativeWebSearch).toBe(false);
  expect((await collect(model.chat(request({ effort: "medium" })))).find((e) => e.type === "text")).toEqual({ type: "text", delta: "c" });
  expect(bodies.slice(3).map((b) => !!b.generationConfig)).toEqual([true, false]);
});

it("refuses media the profile does not read, GIFs included", async () => {
  const model = new GeminiModel({ baseURL: BASE, apiKey: "", token: user, model: "gemini-3.8-flash", inputModalities: ["image", "audio"], provider: "vertex" });
  expect(model.capabilities.mediaInput).toEqual(["image/png", "image/jpeg", "image/webp", "audio/wav", "audio/mpeg"]);
  await expect(collect(model.chat(request({ messages: [{ role: "user", content: [{ type: "media", media: { mime: "image/gif", base64: "A", name: "a.gif" } }] }] })))).rejects.toThrow("does not accept image/gif");
});

const LISTED = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.1-flash-image", "gemini-2.5-flash-tts", "gemini-3.8-live", "gemini-embedding-2", "gemini-live-2.5-flash-native-audio", "gemini-3.5-transcribe-preview", "gemini-omni-flash-preview", "gemini-nano-banana-2.1", "imagen-4.0-generate-001", "veo-3.1-generate-001", "gemma-4-26b-a4b-it-maas", "text-embedding-005"];

it("lists Google's Gemini text models and the open models, page by page, with the credentials as the check", async () => {
  const seen: { url: string; headers: Headers }[] = [];
  let status = 200;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: new Headers(init?.headers) });
    if (status !== 200) return new Response(JSON.stringify({ error: { code: status, message: "Permission 'aiplatform.publishers.get' denied on resource.", status: "PERMISSION_DENIED" } }), { status });
    const first = !url.includes("pageToken");
    const names = first ? LISTED.slice(0, 8) : LISTED.slice(8);
    return new Response(JSON.stringify({ publisherModels: names.map((id) => ({ name: `publishers/google/models/${id}` })), ...(first ? { nextPageToken: "p 2" } : {}) }));
  });
  const signal = new AbortController().signal;
  const listed = await listModels(BASE, { apiKey: "", token: user }, signal);
  expect(listed).toEqual({ ok: true, models: ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-4-argon", "gemini-3.1-pro-preview", "google/gemma-4-26b-a4b-it-maas", ...MAAS] });
  expect(seen.map((s) => s.url)).toEqual([
    "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?listAllVersions=false&pageSize=300",
    "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?listAllVersions=false&pageSize=300&pageToken=p%202"
  ]);
  expect(seen[0]!.headers.get("x-goog-user-project")).toBe("quota-project");
  seen.length = 0;
  await listModels("https://europe-west4-aiplatform.googleapis.com/v1/projects/my-project/locations/europe-west4", { apiKey: "", token: user }, signal);
  expect(seen[0]!.url).toMatch(/^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1beta1\//);

  status = 403;
  expect(await listModels(BASE, { apiKey: "", token: user }, signal)).toEqual({ ok: false, status: 403, detail: "403 PERMISSION_DENIED: Permission 'aiplatform.publishers.get' denied on resource." });
  expect(await listModels(BASE, { apiKey: "", token: async () => { throw new Error("gcloud is not installed"); } }, signal)).toEqual({ ok: false, detail: "gcloud is not installed" });
  expect(await listModels("https://aiplatform.googleapis.com/v1/projects//locations/global", { apiKey: "", token: user }, signal)).toEqual({ ok: false, detail: NO_PROJECT });
  seen.length = 0;
  // a key cannot list; the save check's one-token answer tries it
  expect(await listModels(BASE, { apiKey: "AQ.key", token: user }, signal)).toEqual({ ok: true, models: KEY_MODELS });
  expect(seen).toHaveLength(0);
});

it("puts Gemini first, the newest first, and knows what Gemini reads", () => {
  expect(usable(["gemini-2.5-pro", "openai/gpt-oss-120b-maas", "gemini-3.8-flash", "gemini-4-argon", "gemini-3.10-flash", "google/gemma-4-26b-a4b-it-maas", "gemini-2.5-flash-tts"])).toEqual([
    "gemini-4-argon",
    "gemini-3.10-flash",
    "gemini-3.8-flash",
    "gemini-2.5-pro",
    "openai/gpt-oss-120b-maas",
    "google/gemma-4-26b-a4b-it-maas"
  ]);
  expect(media("gemini-3.8-flash")).toEqual({ inputModalities: ["image", "pdf", "audio", "video"], outputModalities: [] });
  expect(media("google/gemini-4-argon")?.inputModalities).toContain("video");
  expect(media("deepseek-ai/deepseek-v3.2-maas")).toBeUndefined();
  expect(media("gemini-3.8-flash", { inputModalities: ["image"], outputModalities: [] })).toEqual({ inputModalities: ["image"], outputModalities: [] });
});

/** The provider as the plugin registers it, with `compatible` remembering what it was asked to build. */
async function registered() {
  let spec: ModelProviderSpec | null = null;
  const built: CompatibleModelOptions[] = [];
  const ctx = {
    namespace: "vertex",
    models: {
      registerProvider: async (s: ModelProviderSpec) => ((spec = s), () => {}),
      compatible: (options: CompatibleModelOptions) => (built.push(options), { capabilities: { tools: true, streaming: true, json: true }, chat: async function* () {} })
    }
  };
  await (vertex as unknown as { apply(ctx: unknown): Promise<void> }).apply(ctx);
  return { spec: spec!, built };
}

it("registers a provider that needs no key, on the project the person works in, with both presets", async () => {
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "my-project");
  const { spec } = await registered();
  expect(spec).toMatchObject({ id: "vertex", title: { en: "Google Vertex AI", zh: "Google Vertex AI" }, keyRequired: false, baseURL: { default: BASE } });
  expect(spec.presets!.map((p) => [p.id, p.model, p.local ?? false, p.env, p.keyPage])).toEqual([
    ["vertex", "gemini-3.8-flash", true, undefined, undefined],
    ["vertex-key", "gemini-3.8-flash", false, "GOOGLE_API_KEY", "https://console.cloud.google.com/agent-platform/studio/settings/api-keys"]
  ]);
  const model = spec.build({ id: "v", title: "", provider: "vertex", apiKey: "", model: "gemini-3.8-flash", inputModalities: ["image", "pdf"] });
  expect(model).toBeInstanceOf(GeminiModel);
  expect(model.capabilities).toMatchObject({ tools: true, json: true, nativeWebSearch: false, mediaInput: ["image/png", "image/jpeg", "image/webp", "application/pdf"] });
});

it("builds the open models on the app's compatible adapter at Vertex's OpenAI endpoint, a fresh token in the headers, and refuses them to an API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vertex-adc-"));
  const file = join(dir, "application_default_credentials.json");
  writeFileSync(file, JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "secret", refresh_token: "1//refresh", quota_project_id: "quota-project" }));
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
  vi.stubEnv("GOOGLE_CLOUD_PROJECT", "my-project");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "ya29.maas", expires_in: 3600 })));
  try {
    const { spec, built } = await registered();
    spec.build({ id: "d", title: "", provider: "vertex", apiKey: "", model: "deepseek-ai/deepseek-v3.2-maas" });
    spec.build({ id: "g", title: "", provider: "vertex", baseURL: "projects/other-project/locations/us-central1", apiKey: "", model: "google/gemma-4-26b-a4b-it-maas" });
    expect(built.map((b) => [b.baseURL, b.apiKey, b.model, b.webSearch])).toEqual([
      [`${BASE}/endpoints/openapi`, "", "deepseek-ai/deepseek-v3.2-maas", undefined],
      ["https://us-central1-aiplatform.googleapis.com/v1/projects/other-project/locations/us-central1/endpoints/openapi", "", "google/gemma-4-26b-a4b-it-maas", undefined]
    ]);
    expect(await built[0]!.headers!({ url: `${BASE}/endpoints/openapi/chat/completions`, body: "{}" })).toEqual({ authorization: "Bearer ya29.maas", "x-goog-user-project": "quota-project" });
    expect(spec.build({ id: "x", title: "", provider: "vertex", apiKey: "", model: "google/gemini-3.8-flash" })).toBeInstanceOf(GeminiModel);
    const keyed = spec.build({ id: "k", title: "", provider: "vertex", apiKey: "AQ.key", model: "openai/gpt-oss-120b-maas" });
    await expect(collect(keyed.chat(request()))).rejects.toThrow(/serves only to Google Cloud credentials/);
    expect(built).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
