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
  setup?: { install: string[]; signIn?: string; signInRuns?: boolean };
  permissionModes?: unknown;
  picks: { key: string; freeText?: boolean; choices: { value: string }[] }[];
};

/** `tomrade-plugin test` scenario: Antigravity CLI as Tomrade's own conductor registers it. The sandbox runs no program, so its CLI is the unit tests' to stand in for. */
export default async function scenario(t: { check(name: string, ok: boolean, detail?: string): void; localAgents: { engine(id: string): Engine | null } }) {
  const engine = t.localAgents.engine("agy");
  const seen = JSON.stringify(engine);
  t.check("registers Antigravity CLI as an engine for code and general work", engine?.title === "Antigravity CLI" && engine.author === "ai:agy" && engine.capabilities?.join() === "code,general", seen);
  t.check("that runs only in a terminal, reaching Tomrade through its own connection and claiming first", !!engine?.terminalOnly && !!engine.terminalViaLink && !!engine.terminalClaims && engine.mcpLink && !engine.permissionModes, seen);
  t.check("installs with Antigravity's own installer and signs in by running `agy`", !!engine?.setup?.install[0]?.includes("antigravity.google/cli/install") && engine.setup.signIn === "agy" && !!engine.setup.signInRuns, seen);
  const [model, effort] = engine?.picks ?? [];
  t.check("whose Model is free text and whose Effort runs from low to max", model?.key === "model" && !!model.freeText && effort?.key === "effort" && effort.choices.map((c) => c.value).join() === "low,medium,high,xhigh,max", seen);
  t.check("with no settings form, its settings kept as the built-in kept them", engine?.options === false, seen);
}
