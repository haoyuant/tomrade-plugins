type Collected = { text: string; toolCalls: unknown[]; stop: string };
type Profile = { id: string; title: string; provider: string; baseURL?: string; apiKey: string; model: string };

/** One event stream message, string headers only, as Bedrock frames it (CRCs left zero; the reader leaves them to TLS). */
function frame(event: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  for (const [name, value] of Object.entries({ ":event-type": event, ":content-type": "application/json", ":message-type": "event" })) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    bytes.push(n.length, ...n, 7, v.length >> 8, v.length & 255, ...v);
  }
  const p = enc.encode(JSON.stringify(payload));
  const out = new Uint8Array(16 + bytes.length + p.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  view.setUint32(4, bytes.length);
  out.set(bytes, 12);
  out.set(p, 12 + bytes.length);
  return out;
}

/** `tomrade-plugin test` scenario: the provider in Tomrade's real model seam, talking to a stand-in for Bedrock with an API key. */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  models: {
    providers(): { id: string; title: string; keyRequired: boolean }[];
    presets(): { id: string; provider: string; baseURL: string; model: string }[];
    ask(profile: Profile, prompt: string): Promise<Collected>;
  };
}) {
  const provider = t.models.providers().find((p) => p.id === "bedrock");
  t.check("registers the Bedrock provider, which works without a key", provider?.keyRequired === false, JSON.stringify(provider));
  const presets = t.models.presets().filter((p) => p.provider === "bedrock");
  t.check("offers the AWS CLI and API key presets", presets.map((p) => p.id).join() === "bedrock,bedrock-key", presets.map((p) => p.id).join());

  const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    const parts = [
      frame("messageStart", { role: "assistant" }),
      frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hello" } }),
      frame("contentBlockStop", { contentBlockIndex: 0 }),
      frame("messageStop", { stopReason: "end_turn" }),
      frame("metadata", { usage: { inputTokens: 3, outputTokens: 1 } })
    ];
    return new Response(new Blob(parts as BlobPart[]).stream(), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
  }) as typeof fetch;
  try {
    const base = "https://bedrock-runtime.us-west-2.amazonaws.com";
    const answer = await t.models.ask({ id: "b", title: "Bedrock", provider: "bedrock", baseURL: base, apiKey: "ABSKtest", model: "global.anthropic.claude-sonnet-5-5" }, "hi");
    t.check("answers through ConverseStream", answer.text === "Hello" && sent[0]?.url === `${base}/model/global.anthropic.claude-sonnet-5-5/converse-stream`, `${answer.text} ${sent[0]?.url}`);
    t.check("with the API key as a bearer token", sent[0]?.auth === "Bearer ABSKtest", sent[0]?.auth ?? "none");
    t.check("and the prompt as a Converse message", JSON.stringify(sent[0]?.body.messages) === JSON.stringify([{ role: "user", content: [{ text: "hi" }] }]), JSON.stringify(sent[0]?.body));
  } finally {
    globalThis.fetch = real;
  }
}
