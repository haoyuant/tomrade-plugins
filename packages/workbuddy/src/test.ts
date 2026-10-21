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
  setup?: { install: string[]; signIn?: string; signInRuns?: boolean };
  permissionModes?: { default: string; choices: { value: string }[] };
  picks: { key: string }[];
};

/** `tomrade-plugin test` scenario: WorkBuddy as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("workbuddy");
  const seen = JSON.stringify(engine);
  t.check("registers WorkBuddy as an ACP engine for conversations and tickets, named for the CodeBuddy CLI it runs on", engine?.title === "CodeBuddy (WorkBuddy)" && engine.author === "ai:workbuddy" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, takes messages mid-turn, and connects its own sessions", !!engine?.terminal && !engine.terminalViaLink && !!engine.steers && engine.mcpLink, seen);
  t.check("full access by default, asking, or read only", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,ask,read-only", seen);
  t.check("installs the CodeBuddy CLI with npm and signs in inside `codebuddy`", engine?.setup?.install.join() === "npm install -g @tencent-ai/codebuddy-code" && engine.setup.signIn === "codebuddy" && !!engine.setup.signInRuns, seen);
  t.check("whose models come from its help and its sessions", engine?.picks.map((p) => p.key).join() === "model", seen);
}
