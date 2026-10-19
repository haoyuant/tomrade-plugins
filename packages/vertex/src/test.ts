type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for Vertex AI with an API key. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "vertex");
  t.check("registers the Vertex AI provider, which works without a key", provider?.keyRequired === false, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "vertex");
  t.check("offers the gcloud and API key presets", presets.map((p) => p.id).join() === "vertex,vertex-key", presets.map((p) => p.id).join());

  const sent: { url: string; key: string | null; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), key: headers.get("x-goog-api-key"), auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const chunks = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo", thoughtSignature: "c2ln" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "v", title: "Vertex AI", provider: "vertex", apiKey: "AQ.test", model: "gemini-3.8-flash" }, "hi");
    const url = "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse";
    t.check("answers through streamGenerateContent on the publisher path", answer.text === "Hello" && sent[0]?.url === url, `${answer.text} ${sent[0]?.url}`);
    t.check("with the API key in x-goog-api-key and no bearer token", sent[0]?.key === "AQ.test" && sent[0]?.auth === null, `${sent[0]?.key} ${sent[0]?.auth}`);
    t.check("and the prompt as a user content", JSON.stringify(sent[0]?.body.contents) === JSON.stringify([{ role: "user", parts: [{ text: "hi" }] }]), JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
