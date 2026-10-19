import { ANSWER_TOKENS, MAINLAND } from "./doubao.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for Volcengine Ark. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "doubao");
  t.check("registers the Doubao provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "doubao");
  t.check("offers Volcengine Ark and BytePlus ModelArk presets", presets.map((p) => p.id).join() === "doubao,doubao-byteplus", presets.map((p) => p.id).join());

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "d", title: "Doubao", provider: "doubao", baseURL: MAINLAND, apiKey: "ark-test", model: "doubao-seed-2-1-pro-260915" }, "hi");
    t.check("answers through Ark's chat/completions", answer.text === "你好" && sent[0]?.url === `${MAINLAND}/chat/completions`, sent[0]?.url);
    t.check("with the key as a bearer token", sent[0]?.auth === "Bearer ark-test", sent[0]?.auth ?? "none");
    const body = sent[0]?.body ?? {};
    t.check("and room for a long answer, without max_completion_tokens or thinking", body.max_tokens === ANSWER_TOKENS && !("max_completion_tokens" in body) && !("thinking" in body), JSON.stringify(body));
  } finally {
    globalThis.fetch = real;
  }
}
