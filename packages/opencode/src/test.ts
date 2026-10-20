type Engine = {
  id: string;
  title: string;
  author: string;
  capabilities?: string[];
  terminal?: boolean;
  terminalViaLink?: boolean;
  steers?: boolean;
  options: boolean;
  mcpLink: boolean;
  setup?: { install: string[]; signIn?: string };
  permissionModes?: { default: string; choices: { value: string }[] };
  picks: { key: string }[];
};

/** `tomrade-plugin test` scenario: OpenCode as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("opencode");
  const seen = JSON.stringify(engine);
  t.check("registers OpenCode as an ACP engine for conversations and tickets", engine?.title === "OpenCode" && engine.author === "ai:opencode" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, and whose own sessions connect through its link", !!engine?.terminal && !engine.terminalViaLink && !engine.steers && engine.mcpLink, seen);
  t.check("full access by default, OpenCode's own rules, or read only", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,local,read-only", seen);
  const install = engine?.setup?.install ?? [];
  t.check("installs with OpenCode's own installer or npm and signs in with `opencode auth login`", install.at(-1) === "npm install -g opencode-ai" && (install.length === 1 || install[0]!.includes("opencode.ai/install")) && engine?.setup?.signIn === "opencode auth login", seen);
  t.check("whose models come from `opencode models` and its sessions", engine?.picks.map((p) => p.key).join() === "model", seen);
}
