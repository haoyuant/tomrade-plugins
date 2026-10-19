import { expect, it } from "vitest";
import { MISTRAL, listing, shape } from "../src/mistral.js";

/**
 * Opt-in: the listing and the request as the plugin shapes them, against the
 * real Mistral API. MISTRAL_API_KEY=… pnpm test packages/mistral
 */
const key = process.env.MISTRAL_API_KEY;

const WEATHER = { type: "function", function: { name: "get_weather", description: "The weather in a city now", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } };

/** One streamed turn, read as the app's adapter reads it: a string, or the `text` parts of a list; thinking parts are not the answer. */
async function ask(model: string, extra: Record<string, unknown>, messages: unknown[]) {
  // the body as the adapter writes it, empty system message included, before the plugin shapes it
  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "" }, ...messages], max_tokens: 400, ...extra };
  const res = await fetch(`${MISTRAL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(shape(model, json))
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  const out = { text: "", thought: false, usage: false, calls: [] as { id: string; name: string }[] };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const chunk = JSON.parse(line.slice(6)) as {
      usage?: unknown;
      choices?: { delta?: { content?: string | { type: string; text?: string }[] | null; tool_calls?: { id?: string; function?: { name?: string } }[] } }[];
    };
    if (chunk.usage) out.usage = true;
    const delta = chunk.choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string") out.text += delta.content;
    for (const part of Array.isArray(delta.content) ? delta.content : []) {
      if (part.type === "text") out.text += part.text ?? "";
      if (part.type === "thinking") out.thought = true;
    }
    for (const call of delta.tool_calls ?? []) if (call.id) out.calls.push({ id: call.id, name: call.function?.name ?? "" });
  }
  return out;
}

it.skipIf(!key)("lists the key's chat models, Medium 3.5 among them, reading pictures", async () => {
  const listed = await listing({ apiKey: key! }, AbortSignal.timeout(30_000));
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.models).toContain("mistral-medium-3-5");
  // one name per model, and no embedding, OCR, moderation or speech model
  expect(listed.models).not.toContain("mistral-medium-latest");
  expect(listed.models!.filter((id) => /embed|ocr|moderation|voxtral/.test(id))).toEqual([]);
  expect(listed.capabilities?.["mistral-medium-3-5"]).toEqual({ inputModalities: ["image"], outputModalities: [] });
}, 60_000);

it.skipIf(!key)("answers a plain request without stream_options, its usage streamed all the same", async () => {
  // Large 3 does not take reasoning_effort: the plugin leaves it out
  const answer = await ask("mistral-large-2512", { temperature: 0.2, reasoning_effort: "low" }, [{ role: "user", content: "Reply with the single word: pong" }]);
  expect(answer.text).toMatch(/pong/i);
  expect(answer.usage).toBe(true);
}, 120_000);

it.skipIf(!key)("calls tools under nine-character ids, and takes another provider's from history once renamed", async () => {
  const fresh = await ask("mistral-small-2603", { tools: [WEATHER], tool_choice: "any" }, [{ role: "user", content: "What is the weather in Paris?" }]);
  expect(fresh.calls[0]?.name).toBe("get_weather");
  expect(fresh.calls[0]?.id).toMatch(/^[a-zA-Z0-9]{9}$/);

  const foreign = "call_8f3kQ2xVb7Lm-openai";
  const answer = await ask("mistral-small-2603", { tools: [WEATHER], tool_choice: "auto" }, [
    { role: "user", content: "What is the weather in Paris?" },
    { role: "assistant", content: null, tool_calls: [{ id: foreign, type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
    { role: "tool", tool_call_id: foreign, content: '{"forecast":"sunny","celsius":21}' }
  ]);
  expect(answer.text).toMatch(/sunny|21/i);
}, 120_000);

it.skipIf(!key)("thinks on Medium 3.5 at the effort asked, the thinking kept out of the answer", async () => {
  const answer = await ask("mistral-medium-3-5", { reasoning_effort: "high", max_tokens: 4000 }, [{ role: "user", content: "What is 17 * 23? Answer with the number only." }]);
  expect(answer.thought).toBe(true);
  expect(answer.text).toMatch(/\b391\b/);
}, 180_000);
