import { MAINLAND } from "./minimax.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for MiniMax. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "minimax");
  t.check("registers the MiniMax provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "minimax");
  t.check("offers mainland and international presets", presets.map((p) => p.id).join() === "minimax,minimax-intl", presets.map((p) => p.id).join());

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const stream = [
      '{"choices":[{"delta":{"reasoning_content":"The user greets me."}}]}',
      '{"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}',
      "[DONE]"
    ];
    return new Response(stream.map((data) => `data: ${data}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "m", title: "MiniMax", provider: "minimax", baseURL: MAINLAND, apiKey: "sk-cp-test", model: "MiniMax-M3.1-Flash" }, "hi");
    t.check("answers through MiniMax's chat/completions", sent[0]?.url === `${MAINLAND}/chat/completions`, sent[0]?.url);
    t.check("with the key as a bearer token", sent[0]?.auth === "Bearer sk-cp-test", sent[0]?.auth ?? "none");
    t.check("asking for the thinking apart, and none of it in the answer", sent[0]?.body.reasoning_split === true && answer.text === "你好", `${JSON.stringify(sent[0]?.body)} → ${answer.text}`);
  } finally {
    globalThis.fetch = real;
  }
}
