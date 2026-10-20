import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotSignedIn, type LocalAgentCatalog, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { OpencodeOptions, listedModels, opencode } from "../src/opencode.js";
import { opencodeAsk } from "../src/lend.js";
import { opencodeMcpLink, opencodePlugin, opencodeUserFile, opencodeUserPlugin, withMcpEntry } from "../src/link.js";
import { MCP, fakeCli, io } from "./cli.js";

const saved = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeOpencode(dir: string): string {
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-opencode-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  return bin;
}

it("registers OpenCode as a local agent", async () => {
  const registered: LocalAgentSpec<OpencodeOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<OpencodeOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([opencode]);
});

it("starts `opencode acp`, keeps read-only turns in its plan agent, and can also take a ticket in a terminal", () => {
  const acp = opencode.acp!;
  expect(acp.args({ command: "opencode" })).toEqual(["acp"]);
  expect([acp.mode!("full-access"), acp.mode!("ask"), acp.mode!("read-only")]).toEqual(["build", "build", "plan"]);
  expect(acp).toMatchObject({ usage: "turn", cacheApart: true, terminal: true });
  expect(acp.terminalViaLink).toBeUndefined();
  expect(acp.permissionModes).toMatchObject({ default: "full-access" });
  expect(acp.permissionModes.choices.map((c) => c.value)).toEqual(["full-access", "local", "read-only"]);
  expect(opencode).toMatchObject({ id: "opencode", title: "OpenCode", cli: { name: "opencode" }, lend: { rank: 70 } });
  expect(OpencodeOptions.parse({})).toEqual({ command: "opencode" });
});

it("offers the models `opencode models` lists before any session has opened", () => {
  // The probe reads stdout and stderr together.
  const output = "opencode/big-pickle\ndeepseek/deepseek-v4-pro\n\nINFO loading providers\n";
  expect(listedModels(output)).toEqual(["opencode/big-pickle", "deepseek/deepseek-v4-pro"]);
  const catalog: LocalAgentCatalog = { models: [], efforts: [] };
  expect(opencode.probe!.says(output, catalog)).toBeNull();
  expect(catalog.models).toEqual([{ value: "opencode/big-pickle" }, { value: "deepseek/deepseek-v4-pro" }]);
  // A session's own list stays.
  const opened: LocalAgentCatalog = { models: [{ value: "anthropic/claude" }], efforts: [] };
  opencode.probe!.says(output, opened);
  expect(opened.models).toEqual([{ value: "anthropic/claude" }]);
});

describe("connecting OpenCode's own sessions to Tomrade", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-opencode-link-"));
    process.env.XDG_CONFIG_HOME = path.join(dir, "config");
    const link = opencodeMcpLink as Extract<typeof opencodeMcpLink, { status: unknown }>;
    return { link, at: io(fakeCli(fakeOpencode(dir)), { command: "opencode" }), read: () => JSON.parse(fs.readFileSync(opencodeUserFile(), "utf8")) };
  }

  it("adds the tomrade server and the reporting plugin, keeps the rest of opencode.json, and takes both back out", async () => {
    const { link, at, read } = setup();
    const url = MCP.url;
    fs.mkdirSync(path.dirname(opencodeUserFile()), { recursive: true });
    fs.writeFileSync(opencodeUserFile(), JSON.stringify({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] } } }));
    expect(await link.status(at)).toMatchObject({ state: "missing", url, configuredUrl: null, file: opencodeUserFile() });

    expect(await link.connect(at)).toMatchObject({ state: "connected", configuredUrl: url });
    expect(read()).toEqual({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] }, tomrade: { type: "remote", url, enabled: true, headers: { "X-Tomrade-Run": "{env:TOMRADE_MCP_TOKEN}" } } } });
    expect(fs.readFileSync(opencodeUserPlugin(), "utf8")).toBe(opencodePlugin(MCP.eventUrl));

    fs.writeFileSync(opencodeUserFile(), withMcpEntry(fs.readFileSync(opencodeUserFile(), "utf8"), "http://127.0.0.1:1/mcp"));
    const stale = await link.status(at);
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual).toEqual({ connect: `opencode mcp add tomrade --url ${url}`, disconnect: `edit ${opencodeUserFile()} and remove mcp.tomrade` });
    expect(await link.connect(at)).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect(at)).toMatchObject({ state: "missing", configuredUrl: null });
    expect(read()).toEqual({ model: "deepseek/deepseek-flash", mcp: { other: { type: "local", command: ["x"] } } });
    expect(fs.existsSync(opencodeUserPlugin())).toBe(false);
  });

  it("starts a config that is not there, leaves someone else's tomrade.js alone, and reports a file it cannot read", async () => {
    const { link, at, read } = setup();
    fs.mkdirSync(path.dirname(opencodeUserPlugin()), { recursive: true });
    fs.writeFileSync(opencodeUserPlugin(), "export const Mine = async () => ({});\n");
    expect(await link.connect(at)).toMatchObject({ state: "connected" });
    expect(read()).toMatchObject({ $schema: "https://opencode.ai/config.json", mcp: { tomrade: { url: MCP.url } } });
    await link.disconnect(at);
    expect(fs.readFileSync(opencodeUserPlugin(), "utf8")).toBe("export const Mine = async () => ({});\n");
    expect(read()).toEqual({ $schema: "https://opencode.ai/config.json" });
    fs.writeFileSync(opencodeUserFile(), "{ not json");
    expect(await link.status(at)).toMatchObject({ state: "unavailable", error: expect.stringContaining(opencodeUserFile()) });
  });

  it("is unavailable while Tomrade's MCP server is not running", async () => {
    const { link, at } = setup();
    expect(await link.connect({ ...at, mcp: { url: null, eventUrl: null } })).toMatchObject({ state: "unavailable", error: "Tomrade's MCP server is not running" });
    expect(fs.existsSync(opencodeUserFile())).toBe(false);
  });
});

describe("the reporting plugin", () => {
  /** Runs the plugin module against a stand-in for OpenCode's plugin host, as 1.19.3 calls it. */
  async function load(env: Record<string, string> = {}) {
    const source = opencodePlugin("http://127.0.0.1:19090/sessions/event");
    const posted: { url: string; agent: string | null; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    const before = { ...process.env };
    Object.assign(process.env, env);
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.push({ url, agent: init.headers["x-tomrade-agent"] ?? null, body: JSON.parse(init.body) });
      return new Response("{}");
    }) as typeof fetch;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("tomrade.opencode")];
    // vitest imports nothing outside the repository: the module's one export, run as a function.
    const plugin = new Function(source.replace("export const TomradePlugin =", "return"))() as (ctx: { directory: string }) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>;
    const hooks = await plugin({ directory: "/work/app" });
    return { hooks, posted, again: () => plugin({ directory: "/work/app" }), restore: () => { globalThis.fetch = realFetch; process.env = before; } };
  }

  it("reports a session as OpenCode with its folder, in Claude Code's event names", async () => {
    const { hooks, posted, again, restore } = await load();
    try {
      await hooks.event!({ event: { type: "session.created", properties: { sessionID: "ses_1", info: { id: "ses_1" } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user" } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user" } } } });
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: { command: "ls" } });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: { command: "ls" } }, { title: "ls", output: "a\n" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
      await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited" } } } } });
      await tick();
      expect(posted.map((p) => [p.url, p.agent, p.body.hook_event_name, p.body.session_id, p.body.cwd])).toEqual([
        ["http://127.0.0.1:19090/sessions/event", "opencode", "SessionStart", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "UserPromptSubmit", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PreToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PostToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "Stop", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "StopFailure", "ses_1", "/work/app"]
      ]);
      expect(posted[2]!.body).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" } });
      expect(posted[5]!.body).toMatchObject({ error_message: "rate limited" });
      // A second copy (the repository's, beside the global one) does nothing.
      expect(await again()).toEqual({});
    } finally {
      restore();
    }
  });

  it("reports to the session's own address when Tomrade started it", async () => {
    const { hooks, posted, restore } = await load({ TOMRADE_MCP_TOKEN: "tok-9" });
    try {
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
      await tick();
      expect(posted.map((p) => p.url)).toEqual(["http://127.0.0.1:19090/sessions/tok-9/event"]);
    } finally {
      restore();
    }
  });
});

describe("OpenCode answering worker calls", () => {
  const ask = (user: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-lent-"));
    return opencodeAsk({ system: "Reply in JSON.", transcript: user }, io(fakeCli(fakeOpencode(dir)), { command: "opencode", model: "deepseek/deepseek-flash" }));
  };

  it("asks as an agent of its own: the instructions as its whole prompt, every tool denied, no external plugins", async () => {
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; permission: unknown; cwd: string };
    expect(echoed.args).toEqual(["run", "--format", "json", "--pure", "--agent", "tomrade-worker", "-m", "deepseek/deepseek-flash"]);
    expect(echoed.system).toBe("Reply in JSON.");
    expect(echoed.prompt).toBe("plan it");
    expect(echoed.permission).toEqual({ "*": "deny" });
    // what the cache read and wrote is added back to the input
    expect(out).toMatchObject({ inputTokens: 57, cacheReadTokens: 40, outputTokens: 3 });
    expect(fs.existsSync(echoed.cwd)).toBe(false);
    await expect(ask("FAIL")).rejects.toThrow(/OpenCode could not answer: Unexpected server error/);
  }, 30_000);

  it("says it is not signed in while OpenCode has no key for its model, and how to add one", async () => {
    const failed = ask("SIGNED_OUT");
    await expect(failed).rejects.toThrow(/OpenCode has no model it can use \(No API key found for provider anthropic\) — run `opencode auth login`/);
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);
});
