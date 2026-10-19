import { MAINLAND } from "./glm.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for bigmodel.cn. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "glm");
  t.check("registers the GLM provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "glm");
  t.check("offers bigmodel.cn and Z.ai presets", presets.map((p) => p.id).join() === "glm,glm-intl", presets.map((p) => p.id).join());

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "g", title: "GLM", provider: "glm", baseURL: MAINLAND, apiKey: "0123456789abcdef0123456789abcdef.secret", model: "glm-5.3" }, "hi");
    t.check("answers through bigmodel.cn's chat/completions", answer.text === "你好" && sent[0]?.url === `${MAINLAND}/chat/completions`, sent[0]?.url);
    t.check("with the key as a bearer token", sent[0]?.auth === "Bearer 0123456789abcdef0123456789abcdef.secret", sent[0]?.auth ?? "none");
    t.check("shaped for GLM: no stream_options, and no search tool on a plain request", !("stream_options" in (sent[0]?.body ?? {})) && !("tools" in (sent[0]?.body ?? {})), JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
