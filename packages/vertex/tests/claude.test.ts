import { afterEach, expect, it, vi } from "vitest";
import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";
import { claudeBody, readClaude, toMessages } from "../src/claude.js";
import { ClaudeModel } from "../src/claude-model.js";

afterEach(() => vi.unstubAllGlobals());

const sse = (events: Record<string, unknown>[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

async function collect(events: AsyncIterable<ModelChatEvent>): Promise<ModelChatEvent[]> {
  const out: ModelChatEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const BASE = "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global";
const token = async () => ({ token: "ya29.t", user: true, quotaProject: "quota-1" });
const claude = (model = "claude-sonnet-5-5") => new ClaudeModel({ baseURL: BASE, apiKey: "", token, model, inputModalities: ["image", "pdf"], provider: "vertex", retryDelayMs: 1 });
const ask = (patch: Partial<ModelChatRequest> = {}): ModelChatRequest => ({ system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], ...patch });

const start = { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 } } };
const end = (reason: string) => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 7 } }, { type: "message_stop" }];

it("writes a Messages body as Vertex takes it: its version, no model, cached system, tools beside Claude's search, effort", () => {
  const body = claudeBody(
    "claude-sonnet-5-5",
    ask({
      effort: "minimal",
      tools: [{ name: "add", description: "Adds", inputSchema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "media", media: { mime: "application/pdf", base64: "PDF", name: "a.pdf" } }] },
        { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "add", args: { a: 1 } }] },
        { role: "user", content: [{ type: "text", text: "and" }, { type: "tool_result", id: "t1", content: "2" }] }
      ]
    }),
    { provider: "vertex", search: true, effort: true }
  );
  expect(body).toEqual({
    anthropic_version: "vertex-2023-10-16",
    stream: true,
    max_tokens: 32000,
    system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "PDF" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "add", input: { a: 1 } }] },
      // tool results lead the user turn
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "2" }, { type: "text", text: "and" }] }
    ],
    tools: [{ name: "add", description: "Adds", input_schema: { type: "object" } }, { type: "web_search_20260209", name: "web_search" }],
    output_config: { effort: "low" }
  });
  expect(claudeBody("claude-haiku-4-5", ask({ effort: "high" }), { provider: "vertex", search: true, effort: true })).toMatchObject({ tools: [{ type: "web_search_20250305", name: "web_search" }] });
  expect(claudeBody("claude-haiku-4-5", ask({ effort: "high" }), { provider: "vertex", search: false, effort: true })).not.toHaveProperty("output_config");
});

it("streams text, tool calls and cached usage, and keeps signed thinking and searches for the next request of the turn", async () => {
  const sources = new Map<string, string>();
  const gen = readClaude(
    (async function* () {
      for (const e of [
        start,
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://a.example", title: "A" } } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Adding." } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu1", name: "add", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":2}' } },
        { type: "content_block_stop", index: 2 },
        ...end("tool_use")
      ])
        yield JSON.stringify(e);
    })(),
    sources
  );
  const events: ModelChatEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  expect(events).toEqual([
    { type: "usage", inputTokens: 105, cacheReadTokens: 90, cacheWriteTokens: 5 },
    { type: "text", delta: "Adding." },
    { type: "tool_call", id: "tu1", name: "add", args: { a: 2 } },
    { type: "usage", outputTokens: 7 }
  ]);
  expect(next.value.stop).toBe("tool_use");
  expect(next.value.written[0]).toEqual({ type: "thinking", thinking: "plan", signature: "sig" });
  expect(sources.get("https://a.example")).toBe("A");
  // the next request sends the turn back as Claude wrote it
  const replay = toMessages({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }, { role: "assistant", content: [{ type: "native", provider: "vertex", data: next.value.written }, { type: "tool_call", id: "tu1", name: "add", args: { a: 2 } }] }] }, "vertex");
  expect(replay[1]!.content).toEqual(next.value.written);
});

it("posts to streamRawPredict with Google's token, lists the cited pages and keeps the turn, and resumes a paused search", async () => {
  const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const replies = [
    sse([start, { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"q"}' } }, { type: "content_block_stop", index: 0 }, ...end("pause_turn")]),
    sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://b.example", title: "B" } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found." } }, { type: "content_block_stop", index: 0 }, ...end("end_turn")])
  ];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return replies.shift()!;
  });
  const events = await collect(claude().chat(ask({ webSearch: true })));
  expect(sent[0]!.url).toBe(`${BASE}/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict`);
  expect([sent[0]!.headers.get("authorization"), sent[0]!.headers.get("x-goog-user-project")]).toEqual(["Bearer ya29.t", "quota-1"]);
  // resumed with what it wrote so far
  expect((sent[1]!.body.messages as { role: string; content: { type: string }[] }[]).at(-1)).toMatchObject({ role: "assistant", content: [{ type: "server_tool_use" }] });
  expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : ""))).toEqual(["Found.", "\n\n- [B](https://b.example)"]);
  expect(events.at(-2)).toMatchObject({ type: "native", provider: "vertex" });
  expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
});

it("answers without the search a project turned down, and stops declaring it; retries an overloaded Claude", async () => {
  const replies = [
    new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }),
    new Response('{"error":{"code":400,"message":"web_search tool is not enabled for this project","status":"FAILED_PRECONDITION"}}', { status: 400 }),
    sse([start, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }, { type: "content_block_stop", index: 0 }, ...end("end_turn")])
  ];
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), replies.shift()!));
  const model = claude();
  expect(model.capabilities.nativeWebSearch).toBe(true);
  const events = await collect(model.chat(ask({ webSearch: true })));
  expect(events[0]).toEqual({ type: "retry", attempt: 1, max: 2, reason: "HTTP 529", delayMs: 1 });
  expect(events.find((e) => e.type === "text")).toEqual({ type: "text", delta: "ok" });
  expect(bodies.map((b) => !!(b.tools as unknown[] | undefined)?.length)).toEqual([true, true, false]);
  expect(model.capabilities.nativeWebSearch).toBe(false);
  vi.stubGlobal("fetch", async () => new Response('{"error":{"code":404,"message":"Publisher Model `claude-x` was not found","status":"NOT_FOUND"}}', { status: 404 }));
  await expect(collect(claude("claude-x").chat(ask()))).rejects.toThrow("Claude on Vertex AI request failed 404 NOT_FOUND: Publisher Model `claude-x` was not found");
});
