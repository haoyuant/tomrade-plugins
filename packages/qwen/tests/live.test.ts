import { expect, it } from "vitest";
import { MAINLAND, searches, shape, usable } from "../src/qwen.js";

/**
 * Opt-in: Qwen's own fields against the real Model Studio, the request shaped
 * as the plugin shapes it. DASHSCOPE_API_KEY=… pnpm test packages/qwen
 * (DASHSCOPE_BASE_URL for the international or a workspace address).
 */
const key = process.env.DASHSCOPE_API_KEY;
const base = process.env.DASHSCOPE_BASE_URL || MAINLAND;

async function ask(model: string, request: { webSearch?: boolean; effort?: string }, prompt: string) {
  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }], max_tokens: 200 };
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(shape(model, json, { system: "", messages: [], ...request }))
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "")
    .join("");
}

it.skipIf(!key)("Model Studio lists the key's models, searches with enable_search and switches thinking with enable_thinking", async () => {
  const listing = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  // a listing-less endpoint is fine (the profile starts on qwen-plus); one that lists must list chat models
  if (listing.ok) expect(usable(((await listing.json()) as { data: { id: string }[] }).data.map((m) => m.id))).toContain("qwen-plus");
  else expect([404, 405]).toContain(listing.status);

  expect(searches("qwen-plus")).toBe(true);
  expect(await ask("qwen-plus", { webSearch: true }, "What is today's date? Answer in one short line.")).not.toBe("");
  expect(await ask(process.env.QWEN_HYBRID_MODEL || "qwen3.7-flash", { effort: "low" }, "Reply with the single word: pong")).toMatch(/pong/i);
}, 120_000);
