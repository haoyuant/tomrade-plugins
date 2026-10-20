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
  setup?: { install: string[]; signIn?: string; docs?: string };
  permissionModes?: { default: string; choices: { value: string }[] };
  picks: { key: string; choices: { value: string }[] }[];
};

/** `tomrade-plugin test` scenario: DeepSeek Harness as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("dsh");
  const seen = JSON.stringify(engine);
  t.check("registers DeepSeek Harness as the dsh ACP engine for conversations and tickets", engine?.title === "DeepSeek Harness" && engine.author === "ai:dsh" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, with no connection of its own to manage", !!engine?.terminal && !engine.terminalViaLink && !engine.steers && !engine.mcpLink, seen);
  t.check("full access by default, or its own local rules", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,local", seen);
  t.check("installs its CLI with npm, beside the desktop app, and signs in with `dsh web`", engine?.setup?.install.join() === "npm install -g @deepseek-ai/dsh" && engine.setup.signIn === "dsh web" && engine.setup.docs === "https://www.deepseek.com/en/harness/", seen);
  t.check("offers its reasoning efforts before a session has listed them", engine?.picks.map((p) => p.key).join() === "model,effort" && engine.picks[1]!.choices.map((c) => c.value).join() === "off,low,high,max", seen);
}
