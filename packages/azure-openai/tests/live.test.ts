import { expect, it } from "vitest";
import { address, auth, shape, usable } from "../src/azure.js";

/**
 * Opt-in: the provider's requests against a real Azure resource.
 * AZURE_OPENAI_ENDPOINT=… AZURE_OPENAI_API_KEY=… pnpm test packages/azure-openai
 * (AZURE_OPENAI_DEPLOYMENT=… adds a chat and a web search on that deployment).
 */
const base = address(process.env.AZURE_OPENAI_ENDPOINT);
const key = process.env.AZURE_OPENAI_API_KEY;
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

const post = (path: string, body: Record<string, unknown>) =>
  fetch(`${base}${path}`, { method: "POST", headers: { ...auth(key!), "content-type": "application/json" }, body: JSON.stringify(body) });

it.skipIf(!base || !key)("the resource lists the models it can deploy for the key in api-key, and turns a wrong key away", async () => {
  const listing = await fetch(`${base}/models`, { headers: auth(key!) });
  expect(listing.status, (await listing.clone().text()).slice(0, 300)).toBe(200);
  expect(usable(((await listing.json()) as { data: { id: string }[] }).data.map((m) => m.id)).length).toBeGreaterThan(0);
  expect((await fetch(`${base}/models`, { headers: auth("not-a-key") })).status).toBe(401);
}, 60_000);

it.skipIf(!base || !key || !deployment)("the deployment answers chat/completions with max_completion_tokens, and searches on the Responses API or refuses so", async () => {
  const json = { model: deployment, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Reply with the single word: pong" }], max_tokens: 200 };
  const chat = await post("/chat/completions", shape(json));
  const text = await chat.text();
  expect(chat.status, text.slice(0, 300)).toBe(200);
  const said = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => (JSON.parse(l.slice(6)) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content ?? "")
    .join("");
  expect(said).toMatch(/pong/i);

  // a model before GPT-4, or a subscription whose admin blocked the tool, refuses: Tomrade then searches another way
  const search = await post("/responses", { model: deployment, input: "Search the web for today's top news headline and give it in one short line.", tools: [{ type: "web_search" }], store: false });
  const answer = await search.text();
  if (search.ok) expect(((JSON.parse(answer) as { output: { type: string }[] }).output ?? []).map((o) => o.type)).toEqual(expect.arrayContaining(["web_search_call", "message"]));
  else expect([400, 404, 422], answer.slice(0, 300)).toContain(search.status);
}, 120_000);
