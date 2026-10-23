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
  setup?: { install: string[]; signIn?: string };
  permissionModes?: { default: string; choices: { value: string }[] };
  picks: { key: string; freeText?: boolean }[];
};

/** `tomrade-plugin test` scenario: Cursor as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("cursor");
  const seen = JSON.stringify(engine);
  t.check("registers Cursor as an ACP engine for conversations and tickets", engine?.title === "Cursor" && engine.author === "ai:cursor" && engine.capabilities?.join() === "backlog,code,general" && engine.options, seen);
  t.check("that can also take a ticket in a terminal, reaching Tomrade through its own connection", !!engine?.terminal && !!engine.terminalViaLink && !engine.terminalOnly && !engine.steers && engine.mcpLink, seen);
  t.check("full access by default, asking, or read only", engine?.permissionModes?.default === "full-access" && engine.permissionModes.choices.map((c) => c.value).join() === "full-access,ask,read-only", seen);
  t.check("installs with Cursor's own installer and signs in with `cursor-agent login`", !!engine?.setup?.install[0]?.includes("cursor.com/install") && engine.setup.signIn === "cursor-agent login", seen);
  t.check("whose Model is typed in", engine?.picks.map((p) => `${p.key}:${p.freeText}`).join() === "model:true", seen);
}
