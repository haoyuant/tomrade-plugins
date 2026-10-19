import { expect, it } from "vitest";
import { API, languageModels, searches, shape, usable } from "../src/xai.js";

/**
 * Opt-in: xAI's own fields against the real API, each request as the app sends
 * it and the plugin shapes it. XAI_API_KEY=… pnpm test packages/xai
 */
const key = process.env.XAI_API_KEY;
const model = process.env.XAI_MODEL || "grok-4.7";

/** The streamed events' `data:` lines, parsed. */
const events = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return events(text);
}

it.skipIf(!key)("xAI lists its chat models with their media, answers chat/completions as shaped, and searches on the Responses API", async () => {
  const listing = await languageModels(API, key!, AbortSignal.timeout(15_000));
  expect(listing).toMatchObject({ ok: true });
  const models = listing?.ok ? (listing.models ?? []) : [];
  expect(usable(models)).toContain(model);
  expect(listing?.ok && listing.capabilities?.[model]).toEqual({ inputModalities: ["image"], outputModalities: [] });

  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 200, reasoning_effort: "minimal" };
  const chat = await post("chat/completions", shape(model, json));
  expect(chat.map((e) => (e as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "").join("")).toMatch(/pong/i);

  // the app's Responses body for a searching request
  expect(searches(model)).toBe(true);
  const search = await post("responses", {
    model,
    instructions: "",
    input: [{ role: "user", content: [{ type: "input_text", text: "What is today's date? Search the web and answer in one short line." }] }],
    stream: true,
    store: false,
    tools: [{ type: "web_search" }],
    max_output_tokens: 2000,
    reasoning: { effort: "low" }
  });
  expect(search.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta).join("")).not.toBe("");
  expect(search.some((e) => (e.item as { type?: string } | undefined)?.type === "web_search_call")).toBe(true);
}, 180_000);
