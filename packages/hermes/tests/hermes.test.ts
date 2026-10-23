import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NotSignedIn, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { HermesOptions, hermes, hermesAcpReady } from "../src/hermes.js";
import { fitsCommandLine } from "../src/command-line.js";
import { hermesAsk } from "../src/lend.js";
import { hermesConfigFile, hermesMcpLink, hermesPlugin, hermesPluginDir, TOKEN_HEADER } from "../src/link.js";
import { MCP, fakeCli, io } from "./cli.js";

const saved = process.env.HERMES_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = saved;
  delete process.env.FAKE_FAIL;
});

function fakeHermes(dir: string): string {
  const bin = path.join(dir, "hermes");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-hermes.mjs")}' "$@"\n`, { mode: 0o700 });
  return bin;
}

it("registers Hermes as a local agent", async () => {
  const registered: LocalAgentSpec<HermesOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<HermesOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([{ ...hermes, lend: { rank: 60, ask: expect.any(Function) } }]);
});

it("reads `hermes acp --check`: ready, missing its ACP extra, or something else", () => {
  expect(hermesAcpReady("Hermes ACP check OK\n")).toBe(true);
  expect(hermesAcpReady("Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named 'acp'")).toBe(false);
  expect(hermesAcpReady("usage: hermes [-h]")).toBeNull();
});

it("starts `hermes acp`, hands it Tomrade's tools over HTTP and reopens sessions by loading them", () => {
  const acp = hermes.acp!;
  expect(acp.args({ command: "hermes" })).toEqual(["acp"]);
  expect([acp.mode!("full-access"), acp.mode!("ask"), acp.mode!("read-only")]).toEqual(["dont_ask", "default", "default"]);
  expect(acp).toMatchObject({ httpMcp: "always", reopen: "load", usage: "turn", steer: "slash", terminal: true, terminalViaLink: true });
  expect(acp.permissionModes.choices.map((choice) => choice.value)).toEqual(["full-access", "ask"]);
  expect(acp.efforts).toBeUndefined();
  expect(hermes).toMatchObject({ id: "hermes", title: "Hermes", cli: { name: "hermes" }, lend: { rank: 60 } });
  expect(HermesOptions.parse({})).toEqual({ command: "hermes" });
});

// Every hermes call here is a Node process (tests/fake-hermes.mjs), and one test
// spawns four of them; under a full parallel run that outlasts vitest's 5s
// default, which made "leaves a plugin folder … alone" fail at random (TOM-553).
describe("connecting Hermes' own sessions to Tomrade", { timeout: 20_000 }, () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-link-"));
    process.env.HERMES_HOME = path.join(dir, "home");
    fs.mkdirSync(process.env.HERMES_HOME);
    const config = () => parse(fs.readFileSync(hermesConfigFile(), "utf8"));
    const link = hermesMcpLink as Extract<typeof hermesMcpLink, { status: unknown }>;
    return { config, link, at: io(fakeCli(fakeHermes(dir)), { command: "hermes" }) };
  }

  it("adds a tomrade server naming the session token, turns the reporting plugin on, and takes both back off", async () => {
    const { config, link, at } = setup();
    fs.writeFileSync(hermesConfigFile(), "model:\n  default: some/model\nmcp_servers:\n  github:\n    url: https://example.com/mcp\n");
    const url = MCP.url;
    expect(await link.status(at)).toMatchObject({ state: "missing", url, configuredUrl: null, file: hermesConfigFile() });

    expect(await link.connect(at)).toMatchObject({ state: "connected", configuredUrl: url });
    expect(config()).toMatchObject({ model: { default: "some/model" }, mcp_servers: { github: { url: "https://example.com/mcp" }, tomrade: { url, headers: { "X-Tomrade-Run": TOKEN_HEADER }, timeout: 600 } }, plugins: { enabled: ["tomrade"] } });
    expect(fs.readFileSync(path.join(hermesPluginDir(), "__init__.py"), "utf8")).toBe(hermesPlugin(MCP.eventUrl).source);
    expect(fs.readFileSync(path.join(hermesPluginDir(), "plugin.yaml"), "utf8")).toBe(hermesPlugin(MCP.eventUrl).manifest);

    fs.writeFileSync(hermesConfigFile(), fs.readFileSync(hermesConfigFile(), "utf8").replace(url, "http://127.0.0.1:1/mcp"));
    const stale = await link.status(at);
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual.connect).toBe(`hermes config set mcp_servers.tomrade.url ${url} && hermes config set mcp_servers.tomrade.headers.X-Tomrade-Run '\${TOMRADE_MCP_TOKEN}' && hermes config set mcp_servers.tomrade.timeout 600`);
    expect(await link.connect(at)).toMatchObject({ state: "connected", configuredUrl: url });

    expect(await link.disconnect(at)).toMatchObject({ state: "missing", configuredUrl: null });
    expect(config().mcp_servers).toEqual({ github: { url: "https://example.com/mcp" } });
    expect(config().plugins.enabled).toEqual([]);
    expect(fs.existsSync(hermesPluginDir())).toBe(false);
  });

  it("leaves a plugin folder called tomrade that is someone else's alone", async () => {
    const { config, link, at } = setup();
    fs.mkdirSync(hermesPluginDir(), { recursive: true });
    fs.writeFileSync(path.join(hermesPluginDir(), "__init__.py"), "def register(ctx): pass\n");
    expect(await link.connect(at)).toMatchObject({ state: "connected" });
    expect(fs.readFileSync(path.join(hermesPluginDir(), "__init__.py"), "utf8")).toBe("def register(ctx): pass\n");
    expect(config().plugins).toBeUndefined();
    await link.disconnect(at);
    expect(fs.existsSync(hermesPluginDir())).toBe(true);
  });

  it("says what failed", async () => {
    const { link, at } = setup();
    process.env.FAKE_FAIL = "1";
    expect(await link.connect(at)).toMatchObject({ state: "missing", error: expect.stringContaining("fake failure") });
  });

  it("is unavailable while Tomrade's MCP server is not running", async () => {
    const { link, at } = setup();
    expect(await link.connect({ ...at, mcp: { url: null, eventUrl: null } })).toMatchObject({ state: "unavailable", error: "Tomrade's MCP server is not running" });
  });
});

describe("the reporting plugin", () => {
  const python = (() => { try { execFileSync("python3", ["--version"]); return true; } catch { return false; } })();

  it.skipIf(!python)("posts Claude Code's event names, tokenless outside Tomrade and to the session's address inside", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-plugin-"));
    fs.writeFileSync(path.join(dir, "tomrade_plugin.py"), hermesPlugin("http://127.0.0.1:19090/sessions/event").source);
    // Hermes calls register(ctx) and then each hook with keyword arguments; urllib is replaced so nothing leaves.
    const driver = `
import json, os, sys, threading
sys.path.insert(0, ${JSON.stringify(dir)})
sent = []
import urllib.request
class Fake:
    def __init__(self, request, timeout=None): sent.append((request.full_url, request.headers, json.loads(request.data)))
    def read(self): return b"{}"
urllib.request.urlopen = Fake
threading.Thread = type("T", (), {"__init__": lambda self, target=None, daemon=None: setattr(self, "t", target), "start": lambda self: self.t()})
import tomrade_plugin
hooks = {}
tomrade_plugin.register(type("C", (), {"register_hook": lambda self, name, fn: hooks.__setitem__(name, fn)})())
hooks["on_session_start"](session_id="s1", model="m", platform="cli")
hooks["pre_tool_call"](tool_name="terminal", args={"command": "ls"}, session_id="s1", task_id="t")
hooks["post_tool_call"](tool_name="read_file", args={}, result="oops", session_id="s1", status="error", error_message="no such file")
hooks["on_session_end"](session_id="s1", completed=True, failed=False)
os.environ["TOMRADE_MCP_TOKEN"] = "tok-9"
hooks["on_session_finalize"](session_id="s1", platform="cli")
print(json.dumps({"sent": [[u, {k.lower(): v for k, v in h.items()}, b] for u, h, b in sent]}))
`;
    const out = JSON.parse(execFileSync("python3", ["-c", driver], { encoding: "utf8", env: { PATH: process.env.PATH } })) as { sent: [string, Record<string, string>, Record<string, unknown>][] };
    expect(out.sent.map(([url, headers, body]) => [url, headers["x-tomrade-agent"], body.hook_event_name, body.session_id])).toEqual([
      ["http://127.0.0.1:19090/sessions/event", "hermes", "SessionStart", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "PreToolUse", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "PostToolUseFailure", "s1"],
      ["http://127.0.0.1:19090/sessions/event", "hermes", "Stop", "s1"],
      ["http://127.0.0.1:19090/sessions/tok-9/event", "hermes", "SessionEnd", "s1"]
    ]);
    expect(out.sent[1]![2]).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: expect.any(String) });
    expect(out.sent[2]![2]).toMatchObject({ tool_name: "Read", tool_error: "no such file" });
  });

  it.skipIf(!python)("sets the token header's variable to none unless a session brings its own", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-plugin-"));
    fs.writeFileSync(path.join(dir, "tomrade_plugin.py"), hermesPlugin("http://127.0.0.1:19090/sessions/event").source);
    const read = (env: Record<string, string>) => execFileSync("python3", ["-c", `import os, sys; sys.path.insert(0, ${JSON.stringify(dir)}); import tomrade_plugin; print(os.environ["TOMRADE_MCP_TOKEN"])`], { encoding: "utf8", env: { PATH: process.env.PATH!, ...env } }).trim();
    expect(read({})).toBe("none");
    expect(read({ TOMRADE_MCP_TOKEN: "tok-1" })).toBe("tok-1");
  });
});

describe("Hermes answering worker calls", () => {
  const ask = (user: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hermes-lent-"));
    return hermesAsk({ system: "Reply in JSON.", transcript: user }, io(fakeCli(fakeHermes(dir)), { command: "hermes", model: "openrouter:some/model" }));
  };

  it("asks one-shot with nothing loaded but its todo list, the instructions leading the prompt", async () => {
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; cwd: string };
    expect(echoed.args).toEqual(["-t", "todo", "--ignore-rules", "--usage-file", expect.stringMatching(/tomrade-hermes-lent-.*usage\.json$/), "-m", "openrouter:some/model"]);
    expect(echoed.prompt).toBe("Reply in JSON.\n\n---\n\nplan it");
    // titling calls count; cached prompt tokens are added back to the input
    expect(out).toMatchObject({ inputTokens: 64, cacheReadTokens: 40, outputTokens: 5 });
    expect(fs.existsSync(echoed.cwd)).toBe(false);
    await expect(ask("FAIL")).rejects.toThrow(/Hermes could not answer: HTTP 500: upstream exploded/);
  }, 30_000);

  it("refuses a request this platform's command line cannot hold, in the app's language, before starting Hermes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-hermes-lent-"));
    const log = path.join(dir, "calls.jsonl");
    process.env.TOMRADE_TEST_LOG = log;
    try {
      const huge = { system: "Reply in JSON.", transcript: "x".repeat(2 * 1024 * 1024) };
      const cli = io(fakeCli(fakeHermes(dir)), { command: "hermes" });
      await expect(hermesAsk(huge, cli)).rejects.toThrow(/too long for this computer's command line/);
      await expect(hermesAsk(huge, cli, "zh-CN")).rejects.toThrow(/请求太长/);
      expect(fs.existsSync(log)).toBe(false);
    } finally {
      delete process.env.TOMRADE_TEST_LOG;
    }
  }, 30_000);

  it("says it is not signed in while Hermes has no model it can use, and how to fix it", async () => {
    const failed = ask("SIGNED_OUT");
    await expect(failed).rejects.toThrow(/Hermes has no model it can use \(.*hermes model.*\) — run `hermes setup`/);
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);
});

it("counts a command line in bytes per argument on Linux, bytes in all on macOS, and UTF-16 units of the whole line on Windows", () => {
  const rest = ["hermes", "-t", "todo", "--ignore-rules"];
  expect(fitsCommandLine(["x".repeat(120_000), ...rest], "linux")).toBe(true);
  expect(fitsCommandLine(["x".repeat(131_072), ...rest], "linux")).toBe(false);
  expect(fitsCommandLine(["中".repeat(44_000), ...rest], "linux")).toBe(false);
  expect(fitsCommandLine(["x".repeat(600_000), ...rest], "darwin")).toBe(true);
  expect(fitsCommandLine(["x".repeat(900_000), ...rest], "darwin")).toBe(false);
  expect(fitsCommandLine(["中".repeat(30_000), ...rest], "win32")).toBe(true);
  expect(fitsCommandLine(["x".repeat(32_000), ...rest], "win32")).toBe(false);
  expect(fitsCommandLine(['"'.repeat(16_000), ...rest], "win32")).toBe(false);
});
