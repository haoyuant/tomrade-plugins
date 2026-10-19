type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for an Azure resource. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean; baseURL: { default: string; editable: boolean } }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "azure-openai");
  // the sandbox exports no AZURE_OPENAI_ENDPOINT, so the address is the person's to give
  t.check("registers the Azure OpenAI provider, which needs a key and an address", provider?.keyRequired === true && provider.baseURL.default === "" && provider.baseURL.editable, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "azure-openai");
  t.check("offers one preset, the deployment's name left to the person", presets.map((p) => `${p.id}:${p.model}`).join() === "azure-openai:", JSON.stringify(presets));

  const sent: { url: string; key: string | null; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), key: headers.get("api-key"), auth: headers.get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const answer = await t.models.ask({ id: "a", title: "Azure", provider: "azure-openai", baseURL: "myres", apiKey: "key-test", model: "my-gpt" }, "hi");
    t.check("answers through the resource's v1 chat/completions, the name completed to its address", answer.text === "hello" && sent[0]?.url === "https://myres.openai.azure.com/openai/v1/chat/completions", sent[0]?.url);
    t.check("with the key in api-key, not as a bearer token", sent[0]?.key === "key-test" && sent[0]?.auth === null, `${sent[0]?.key} / ${sent[0]?.auth}`);
    t.check("and the deployment's name as the model", sent[0]?.body.model === "my-gpt", JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
