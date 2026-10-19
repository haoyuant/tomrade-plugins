import { expect, it } from "vitest";
import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";
import { listModels, runtime } from "../src/bedrock.js";
import { cliCredentials, cliRegion } from "../src/credentials.js";
import { BedrockModel } from "../src/model.js";

/**
 * Opt-in, and billed by AWS (a few hundred tokens): the plugin against the real
 * Bedrock. BEDROCK_LIVE=1 pnpm test packages/bedrock uses the AWS CLI's
 * credentials and region; AWS_BEARER_TOKEN_BEDROCK uses that key instead.
 * BEDROCK_MODEL picks another Claude.
 */
const live = process.env.BEDROCK_LIVE === "1";

async function turn(model: BedrockModel, request: ModelChatRequest) {
  const events: ModelChatEvent[] = [];
  for await (const e of model.chat(request)) events.push(e);
  return events;
}

it.skipIf(!live)("lists the region's models and runs a tool loop on Claude, its reasoning sent back", async () => {
  const base = runtime((await cliRegion()) ?? "us-east-1");
  const auth = { apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK ?? "", credentials: cliCredentials() };
  const listed = await listModels(base, auth, AbortSignal.timeout(30_000));
  expect(listed.ok, JSON.stringify(listed)).toBe(true);
  const id = process.env.BEDROCK_MODEL || "global.anthropic.claude-sonnet-5-5";
  const model = new BedrockModel({ baseURL: base, ...auth, model: id, provider: "bedrock" });
  const tools = [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }];
  const ask = { role: "user" as const, content: [{ type: "text" as const, text: "Use the add tool for 2 + 3, then answer with the sum only." }] };
  const first = await turn(model, { system: "You are terse.", messages: [ask], tools, effort: "low", maxTokens: 2000 });
  const call = first.find((e) => e.type === "tool_call");
  expect(call, JSON.stringify(first)).toBeDefined();
  if (call?.type !== "tool_call") return;
  const native = first.filter((e) => e.type === "native").map((e) => (e.type === "native" ? { type: "native" as const, provider: e.provider, data: e.data } : null)!);
  const second = await turn(model, {
    system: "You are terse.",
    tools,
    maxTokens: 2000,
    messages: [ask, { role: "assistant", content: [...native, { type: "tool_call", id: call.id, name: call.name, args: call.args }] }, { role: "user", content: [{ type: "tool_result", id: call.id, content: "5" }] }]
  });
  expect(second.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toMatch(/5/);
}, 120_000);
