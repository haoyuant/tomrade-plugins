type Engine = {
  id: string;
  title: string;
  author: string;
  capabilities?: string[];
  terminalOnly?: boolean;
  terminalViaLink?: boolean;
  terminalClaims?: boolean;
  options: boolean;
  mcpLink: boolean;
  setup?: { install: string[]; signIn?: string };
  permissionModes?: unknown;
  picks: { key: string; freeText?: boolean }[];
};

/** `tomrade-plugin test` scenario: Cursor as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("cursor");
  const seen = JSON.stringify(engine);
  t.check("registers Cursor as an engine for code and conversations", engine?.title === "Cursor" && engine.author === "ai:cursor" && engine.capabilities?.join() === "code,general", seen);
  t.check("that runs only in a terminal, through its own connection, claiming its ticket first", !!engine?.terminalOnly && !!engine.terminalViaLink && !!engine.terminalClaims && engine.mcpLink && !engine.permissionModes, seen);
  t.check("keeps the settings it had, with no schema of its own", engine?.options === false, seen);
  t.check("installs with Cursor's own installer and signs in with `cursor-agent login`", !!engine?.setup?.install[0]?.includes("cursor.com/install") && engine.setup.signIn === "cursor-agent login", seen);
  t.check("whose Model is typed in", engine?.picks.map((p) => `${p.key}:${p.freeText}`).join() === "model:true", seen);
}
