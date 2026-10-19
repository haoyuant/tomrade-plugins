import { API } from "./xai.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for xAI's API. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "xai");
  t.check("registers the xAI provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "xai");
  t.check("offers the xAI Grok preset, starting on grok-4.7", presets.map((p) => `${p.id} ${p.baseURL} ${p.model}`).join() === `xai ${API} grok-4.7`, JSON.stringify(presets));

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "g", title: "Grok", provider: "xai", baseURL: API, apiKey: "xai-test", model: "grok-4.7" }, "hi");
    t.check("answers through xAI's chat/completions", answer.text === "Hello" && sent[0]?.url === `${API}/chat/completions`, sent[0]?.url);
    t.check("with the key as a bearer token", sent[0]?.auth === "Bearer xai-test", sent[0]?.auth ?? "none");
    t.check("asking grok-4.7, without the retired Live Search", sent[0]?.body.model === "grok-4.7" && !("search_parameters" in (sent[0]?.body ?? {})), JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
