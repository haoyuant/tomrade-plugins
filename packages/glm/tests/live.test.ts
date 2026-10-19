import { expect, it } from "vitest";
import { INTERNATIONAL, MAINLAND, shape, usable } from "../src/glm.js";

/**
 * Opt-in: GLM's own fields against the real platforms, the request shaped as
 * the plugin shapes it. ZHIPUAI_API_KEY=… (bigmodel.cn) and/or ZAI_API_KEY=…
 * (Z.ai) pnpm test packages/glm
 */
const platforms = [
  { name: "bigmodel.cn", key: process.env.ZHIPUAI_API_KEY, base: MAINLAND },
  { name: "Z.ai", key: process.env.ZAI_API_KEY, base: INTERNATIONAL }
];

async function ask(base: string, key: string, model: string, request: { webSearch?: boolean; effort?: string }, prompt: string) {
  // as the adapter sends it; thinking counts against max_tokens, so it leaves room for the answer
  const json = { model, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: prompt }], max_tokens: 4000, temperature: 0, ...(request.effort ? { reasoning_effort: request.effort } : {}) };
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(shape(model, base, json, { system: "", messages: [], ...request }))
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "")
    .join("");
}

for (const { name, key, base } of platforms) {
  it.skipIf(!key)(`${name} answers the listing, searches with the web_search tool, and takes the effort as GLM-5.3 and GLM-4.7 want it`, async () => {
    const listing = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
    // a listing-less endpoint is fine (the known models stand in); one that lists must list chat models
    if (listing.ok) expect(usable(((await listing.json()) as { data: { id: string }[] }).data.map((m) => m.id)).some((id) => /^glm-/.test(id))).toBe(true);
    else expect([404, 405]).toContain(listing.status);

    expect(await ask(base, key!, "glm-5.3", { webSearch: true, effort: "low" }, "What is today's date? Answer in one short line.")).not.toBe("");
    expect(await ask(base, key!, "glm-5.3", { effort: "minimal" }, "Reply with the single word: pong")).toMatch(/pong/i);
    expect(await ask(base, key!, "glm-4.7", { effort: "minimal" }, "Reply with the single word: pong")).toMatch(/pong/i);
  }, 300_000);
}
