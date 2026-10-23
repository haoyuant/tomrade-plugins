type Engine = {
  id: string;
  title: string;
  author: string;
  capabilities?: string[];
  terminal?: boolean;
  terminalViaLink?: boolean;
  terminalOnly?: boolean;
  steers?: boolean;
  options: boolean;
  mcpLink: boolean;
  setup?: { install: string[]; signIn?: string; signInRuns?: boolean };
  permissionModes?: { default: string; choices: { value: string }[] };
};

/** `tomrade-plugin test` scenario: Antigravity CLI as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("agy");
  const seen = JSON.stringify(engine);
  t.check("registers Antigravity CLI as an ACP engine for conversations and tickets", engine?.title === "Antigravity CLI" && engine.author === "ai:agy" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, reaching Tomrade through its own connection", !!engine?.terminal && !!engine.terminalViaLink && !engine.terminalOnly && !engine.steers && engine.mcpLink, seen);
  t.check("full access by default, or asking", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,ask", seen);
  t.check("sets up by unpacking Google's ACP server first, then running Antigravity's own installer, and signs in by running `agy`", !!engine?.setup?.install[0]?.startsWith("download https://dl.google.com/agy-extensions/") && !!engine.setup.install[1]?.includes("antigravity.google/cli/install") && engine.setup.signIn === "agy" && !!engine.setup.signInRuns, seen);
}
