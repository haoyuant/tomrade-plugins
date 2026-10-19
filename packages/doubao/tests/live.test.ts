import { expect, it } from "vitest";
import { MAINLAND, known, searches, shape, usable } from "../src/doubao.js";

/**
 * Opt-in: Ark's own fields against the real Volcengine Ark, the request shaped
 * as the plugin shapes it. ARK_API_KEY=… pnpm test packages/doubao
 * (ARK_BASE_URL for BytePlus ModelArk, ARK_MODEL for another switched-on model).
 */
const key = process.env.ARK_API_KEY;
const base = process.env.ARK_BASE_URL || MAINLAND;
const model = process.env.ARK_MODEL || known(base)[0]!;
const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };

async function ask(effort: string, prompt: string) {
  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }], reasoning_effort: effort };
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify(shape(model, json)) });
  const text = await res.text();
  // a model not switched on answers 404 ModelNotOpen, saying to switch it on in the console
  expect(res.status, text.slice(0, 300)).toBe(200);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "")
    .join("");
}

it.skipIf(!key)("Ark checks the key, answers with the plugin's fields, and searches on the Responses API or refuses so Tomrade searches another way", async () => {
  const listing = await fetch(`${base}/models`, { headers: auth });
  // a listing-less endpoint is fine (the plugin offers the known models); one that lists must list chat models
  if (listing.ok) expect(usable(((await listing.json()) as { data: { id: string }[] }).data.map((m) => m.id)).length).toBeGreaterThan(0);
  else expect([404, 405]).toContain(listing.status);

  expect(await ask("minimal", "Reply with the single word: pong")).toMatch(/pong/i);
  if (!searches(model)) return;

  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model, input: [{ role: "user", content: [{ type: "input_text", text: "What is today's date? Answer in one short line." }] }], stream: false, store: false, tools: [{ type: "web_search" }], reasoning: { effort: "low" } })
  });
  const text = await res.text();
  // an account without the search component switched on must refuse in a way the app's adapter falls back from
  if (res.ok) expect(text).toContain("output_text");
  else expect([400, 403, 404, 422], text.slice(0, 300)).toContain(res.status);
}, 180_000);
