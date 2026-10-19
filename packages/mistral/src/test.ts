import { FIELDS, MISTRAL } from "./mistral.js";

type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** Mistral's reasoning stream: thinking chunks, one of them carrying the answer's first text, then plain strings. */
const THINKING = [
  { choices: [{ index: 0, delta: { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "The user greets me in French." }] }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: " Answer in kind." }] }, { type: "text", text: "Bon" }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: "jour" }, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 12, total_tokens: 18 } }
];

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for Mistral that thinks before it answers. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "mistral");
  t.check("registers the Mistral provider, which needs a key", provider?.keyRequired === true, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "mistral");
  const preset = presets[0];
  t.check("offers one preset on La Plateforme, starting on Mistral Medium 3.5", presets.length === 1 && preset?.baseURL === MISTRAL && preset.model === "mistral-medium-3-5", JSON.stringify(presets));

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const stream = THINKING.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "m", title: "Mistral", provider: "mistral", baseURL: MISTRAL, apiKey: "test-key", model: "mistral-medium-3-5" }, "bonjour");
    const chat = sent.find((s) => s.url === `${MISTRAL}/chat/completions`);
    t.check("answers through Mistral's chat/completions", answer.text === "Bonjour" && !!chat, `${answer.text} via ${sent.map((s) => s.url).join()}`);
    t.check("keeps the model's thinking out of the answer", !/greets|in kind/.test(answer.text), answer.text);
    t.check("with the key as a bearer token", chat?.auth === "Bearer test-key", chat?.auth ?? "none");
    const fields = Object.keys(chat?.body ?? {});
    t.check("and only fields Mistral's API takes", fields.length > 0 && fields.every((f) => FIELDS.has(f)) && !fields.includes("stream_options"), fields.join());
  } finally {
    globalThis.fetch = real;
  }
}
