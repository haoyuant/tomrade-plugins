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

/** `tomrade-plugin test` scenario: Hermes as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("hermes");
  const seen = JSON.stringify(engine);
  t.check("registers Hermes as an ACP engine for conversations and tickets", engine?.title === "Hermes" && engine.author === "ai:hermes" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, through its own connection, and takes messages mid-turn", !!engine?.terminal && !!engine.terminalViaLink && !!engine.steers && engine.mcpLink, seen);
  t.check("full access by default, or asking", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,ask", seen);
  t.check("installs with Hermes' own installer and signs in with `hermes setup`", !!engine?.setup?.install[0]?.includes("NousResearch/hermes-agent") && engine.setup.signIn === "hermes setup", seen);
  t.check("whose models come from its sessions", engine?.picks.map((p) => p.key).join() === "model", seen);
}
