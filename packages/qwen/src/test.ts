import { MAINLAND } from "./qwen.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for Model Studio. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "qwen");
  t.check("registers the Qwen provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "qwen");
  t.check("offers mainland and international presets", presets.map((p) => p.id).join() === "qwen,qwen-intl", presets.map((p) => p.id).join());

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "q", title: "Qwen", provider: "qwen", baseURL: MAINLAND, apiKey: "sk-test", model: "qwen-plus" }, "hi");
    t.check("answers through Model Studio's chat/completions", answer.text === "你好" && sent[0]?.url === `${MAINLAND}/chat/completions`, sent[0]?.url);
    t.check("with the key as a bearer token", sent[0]?.auth === "Bearer sk-test", sent[0]?.auth ?? "none");
    t.check("and none of Qwen's own fields on a plain request", !("enable_search" in (sent[0]?.body ?? {})) && !("reasoning_effort" in (sent[0]?.body ?? {})), JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
