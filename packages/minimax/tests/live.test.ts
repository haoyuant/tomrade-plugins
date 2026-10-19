import { expect, it } from "vitest";
import { MAINLAND, searches, shape, usable } from "../src/minimax.js";

/**
 * Opt-in: MiniMax's own fields against the real endpoint, the request shaped
 * as the plugin shapes it. MINIMAX_API_KEY=… pnpm test packages/minimax
 * (MINIMAX_BASE_URL=https://api.minimax.io/v1 for an international key).
 */
const key = process.env.MINIMAX_API_KEY;
const base = process.env.MINIMAX_BASE_URL || MAINLAND;
const model = process.env.MINIMAX_MODEL || "MiniMax-M3.1-Flash";

async function events<T>(path: string, body: Record<string, unknown>): Promise<T[]> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)) as T);
}

it.skipIf(!key)("MiniMax lists the key's models and keeps the thinking out of the answer at the least effort", async () => {
  const listing = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  expect(listing.status).toBe(200);
  expect(usable(((await listing.json()) as { data: { id: string }[] }).data.map((m) => m.id))).toContain(model);

  // what the adapter sends, minimal effort and the old token field included
  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 4000, temperature: 1, reasoning_effort: "minimal" };
  const chunks = await events<{ choices?: { delta?: { content?: string } }[] }>("/chat/completions", shape(model, json));
  const answer = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  expect(answer).toMatch(/pong/i);
  expect(answer).not.toMatch(/<think>/);
}, 120_000);

it.skipIf(!key)("MiniMax's Responses API takes the app's searching request and streams OpenAI's events", async () => {
  expect(searches(model)).toBe(true);
  // the shape of the app's Responses body: instructions, input items, function tools beside web_search
  const streamed = await events<{ type: string; delta?: string }>("/responses", {
    model,
    instructions: "Answer in one short line.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Search the web: what is today's date?" }] }],
    stream: true,
    store: false,
    tools: [{ type: "function", name: "noop", description: "Does nothing.", parameters: { type: "object", properties: {} } }, { type: "web_search" }],
    max_output_tokens: 8000,
    reasoning: { effort: "low" }
  });
  expect(streamed.some((e) => e.type === "response.completed")).toBe(true);
  expect(streamed.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")).not.toBe("");
}, 180_000);
