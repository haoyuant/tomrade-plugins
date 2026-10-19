import { expect, it } from "vitest";
import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";
import { defaultProject, googleToken } from "../src/credentials.js";
import { GeminiModel } from "../src/model.js";
import { base, listModels } from "../src/vertex.js";

/**
 * Opt-in, and billed by Google (a few thousand tokens and one search): the
 * plugin against the real Vertex AI. VERTEX_LIVE=1 pnpm test packages/vertex
 * uses gcloud's credentials and project; VERTEX_API_KEY uses that key instead.
 * VERTEX_MODEL picks another Gemini.
 */
const live = process.env.VERTEX_LIVE === "1";

async function turn(model: GeminiModel, request: ModelChatRequest) {
  const events: ModelChatEvent[] = [];
  for await (const e of model.chat(request)) events.push(e);
  return events;
}

const text = (events: ModelChatEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

it.skipIf(!live)("lists the models, runs a tool loop with Gemini's signatures sent back, and grounds an answer in Google Search", async () => {
  const baseURL = base(await defaultProject());
  const auth = { apiKey: process.env.VERTEX_API_KEY ?? "", token: googleToken() };
  const id = process.env.VERTEX_MODEL || "gemini-3.8-flash";
  const listed = await listModels(baseURL, auth, AbortSignal.timeout(30_000));
  expect(listed.ok && listed.models?.includes(id), JSON.stringify(listed)).toBe(true);

  const model = new GeminiModel({ baseURL, ...auth, model: id, provider: "vertex" });
  const tools = [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } }];
  const ask = { role: "user" as const, content: [{ type: "text" as const, text: "Use the add tool for 2 + 3, then answer with the sum only." }] };
  const first = await turn(model, { system: "You are terse.", messages: [ask], tools, effort: "low", maxTokens: 2000 });
  const call = first.find((e) => e.type === "tool_call");
  expect(call, JSON.stringify(first)).toBeDefined();
  if (call?.type !== "tool_call") return;
  const native = first.flatMap((e) => (e.type === "native" ? [{ type: "native" as const, provider: e.provider, data: e.data }] : []));
  expect(JSON.stringify(native)).toContain("thoughtSignature");
  const second = await turn(model, {
    system: "You are terse.",
    tools,
    effort: "low",
    maxTokens: 2000,
    messages: [ask, { role: "assistant", content: [...native, { type: "tool_call", id: call.id, name: call.name, args: call.args }] }, { role: "user", content: [{ type: "tool_result", id: call.id, content: "5" }] }]
  });
  expect(text(second)).toMatch(/5/);

  const searched = await turn(model, { system: "", webSearch: true, maxTokens: 2000, messages: [{ role: "user", content: [{ type: "text", text: "Search the web: who won the most recent Formula 1 Grand Prix? One line." }] }] });
  expect(text(searched)).toMatch(/\]\(https:\/\//);
}, 180_000);
