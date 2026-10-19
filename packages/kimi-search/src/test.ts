/**
 * `tomrade-plugin test` scenario: the agent's web_search reaches Kimi through
 * Tomrade's own web search module. The sandbox has no Kimi model, so the tool
 * says what to set up instead of searching.
 */
export default async function scenario(t: {
  check(name: string, ok: boolean, detail?: string): void;
  tool(name: string, args?: unknown): Promise<unknown>;
}) {
  const message = await t.tool("web_search", { query: "Tomrade" }).then(
    (text) => `searched without a key: ${String(text)}`,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  );
  t.check("says a Kimi model with a key is needed, and where it goes", /Kimi model with an API key.*Settings → Models/.test(message), message);
}
