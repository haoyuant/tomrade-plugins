import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotSignedIn, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { codebuddyFailure, codebuddyUsage, helpModels, newestLogs, WorkBuddyOptions, workbuddy, workbuddyApps } from "../src/workbuddy.js";
import { ownModel } from "../src/lend.js";
import { codebuddyUserFile, workbuddyMcpLink } from "../src/link.js";
import { MCP, fakeCli, io } from "./cli.js";

const saved = process.env.CODEBUDDY_CONFIG_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
  else process.env.CODEBUDDY_CONFIG_DIR = saved;
  delete process.env.FAKE_MCP_FAIL;
  vi.restoreAllMocks();
});

function fakeCodebuddy(dir: string, script: string, env = ""): string {
  const bin = path.join(dir, "codebuddy");
  fs.writeFileSync(bin, `#!/bin/sh\n${env}exec '${process.execPath}' '${path.resolve(import.meta.dirname, script)}' "$@"\n`, { mode: 0o700 });
  return bin;
}

it("registers WorkBuddy as a local agent", async () => {
  const registered: LocalAgentSpec<WorkBuddyOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<WorkBuddyOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([workbuddy]);
});

it("reads a model request's tokens from CodeBuddy's usage update", () => {
  // As CodeBuddy 2.155 sent it on a second turn, trimmed.
  const update = { sessionUpdate: "usage_update", used: 23574, size: 300000, _meta: { usage: {
    prompt_tokens: 23574, completion_tokens: 9, total_tokens: 23583, prompt_tokens_details: { cached_tokens: 23424 },
    prompt_cache_hit_tokens: 23424, prompt_cache_miss_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, prompt_cache_write_tokens: 0, credit: 0 } } };
  expect(codebuddyUsage(update)).toEqual({ input: 23574, output: 9, cacheRead: 23424, cacheWrite: 0 });
  // The breakdown by category that follows carries no tokens of its own.
  expect(codebuddyUsage({ sessionUpdate: "usage_update", used: 23574, size: 300000, _meta: { "codebuddy.ai/usageByCategory": { tools: 20404 } } })).toBeNull();
  expect(workbuddy.acp!.usage).toBe(codebuddyUsage);
});

it("lists the models `codebuddy --help` names", () => {
  const help = "  --model <model>   Model for the current session. Please provide the model ID. Currently supported: (default-model, fast-model,\n    hy3, deepseek-v4.1-flash)\n  --effort <level>";
  expect(helpModels(help)).toEqual(["default-model", "fast-model", "hy3", "deepseek-v4.1-flash"]);
  expect(helpModels("Usage: codebuddy")).toEqual([]);
});

const noInstalls = async () => [];

it("knows where the WorkBuddy app keeps its CLI and the binary that runs it", async () => {
  expect(workbuddy.cli.bundled).toBe(workbuddyApps);
  const mac = await workbuddyApps({ platform: "darwin", env: {}, home: "/Users/a", installs: noInstalls });
  expect(mac).toContainEqual({ file: "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", runtime: expect.stringMatching(/^\/Applications\/WorkBuddy AI\.app\/Contents\/MacOS\//) });
  expect(mac.map((app) => app.file)).toContain("/Users/a/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy");
  const win = await workbuddyApps({ platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local" }, home: "C:\\Users\\a", installs: noInstalls });
  expect(win).toContainEqual({ file: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "C:\\Users\\a\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddyAI.exe" });
  expect(await workbuddyApps({ platform: "linux", env: {}, home: "/home/a", installs: noInstalls })).toEqual([]);
});

it("finds the WorkBuddy app on Windows wherever it was installed, whatever its exe is called", async () => {
  // The install folders below hold these files; nothing else exists.
  const folders: Record<string, string[]> = {
    "D:\\Apps\\WB": ["WorkBuddy Desktop.exe", "Uninstall WorkBuddy Desktop.exe", "resources"],
    "C:\\Program Files (x86)\\WorkBuddy": ["Uninstall WorkBuddy.exe", "wb.exe"]
  };
  vi.spyOn(fs, "readdirSync").mockImplementation(((dir: string) => {
    if (folders[dir]) return folders[dir];
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as typeof fs.readdirSync);
  const asked: RegExp[] = [];
  const apps = await workbuddyApps({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    home: "C:\\Users\\a",
    installs: async (name) => { asked.push(name); return ["D:\\Apps\\WB"]; }
  });
  expect(asked[0]!.test("WorkBuddy AI 1.4.0")).toBe(true);
  // Where the installer registered it comes first, with the exe this version ships.
  expect(apps[0]).toEqual({ file: "D:\\Apps\\WB\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "D:\\Apps\\WB\\WorkBuddy Desktop.exe" });
  expect(apps).toContainEqual({ file: "C:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy", runtime: "C:\\Program Files (x86)\\WorkBuddy\\wb.exe" });
  expect(apps.map((app) => app.file)).toContain("C:\\Users\\a\\AppData\\Local\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy");
  // A failed registry read still leaves the usual folders.
  const unread = await workbuddyApps({ platform: "win32", env: {}, home: "C:\\Users\\a", installs: async () => { throw new Error("reg.exe"); } });
  expect(unread.length).toBeGreaterThan(0);
});

it("runs `codebuddy --acp`, bypassing its prompts only for a full-access turn, and seeds the models from its help", () => {
  const acp = workbuddy.acp!;
  expect(acp.args({ command: "codebuddy" })).toEqual(["--acp"]);
  expect(acp.env!({ command: "codebuddy" })).toEqual({ CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" });
  expect([acp.mode!("full-access"), acp.mode!("ask"), acp.mode!("read-only")]).toEqual(["bypassPermissions", "default", "default"]);
  expect(acp).toMatchObject({ steer: "method", terminal: true, failure: codebuddyFailure });
  expect(acp).not.toHaveProperty("terminalViaLink");
  expect(acp.permissionModes).toEqual({ default: "full-access", choices: [{ value: "full-access", label: "Full access" }, { value: "ask", label: "Ask permissions" }, { value: "read-only", label: "Read only" }] });
  expect(workbuddy).toMatchObject({ id: "workbuddy", title: "WorkBuddy", cli: { name: "codebuddy" }, signIn: "run `codebuddy` and /login with your WorkBuddy account", lend: { rank: 20 } });
  expect(workbuddy.install).toBe("install WorkBuddy (workbuddy.ai), or its CLI with {install}");
  expect(workbuddy.setup).toEqual({ install: ["npm install -g @tencent-ai/codebuddy-code"], signIn: "codebuddy", signInRuns: true, docs: "https://www.workbuddy.ai/docs/cli/overview" });
  expect(WorkBuddyOptions.parse({})).toEqual({ command: "codebuddy" });
  const catalog = { models: [] as { value: string }[], efforts: [] };
  expect(workbuddy.probe!.args).toEqual(["--help"]);
  expect(workbuddy.probe!.says("Currently supported: (hy3, gpt-5.5)", catalog)).toBeNull();
  expect(catalog.models).toEqual([{ value: "hy3" }, { value: "gpt-5.5" }]);
  // A session's own list is kept over the help's.
  expect(workbuddy.probe!.says("Currently supported: (other)", catalog)).toBeNull();
  expect(catalog.models).toEqual([{ value: "hy3" }, { value: "gpt-5.5" }]);
});

it("tells the troubleshooter which edition it is, and where its newest logs are", () => {
  const facts = workbuddy.diagnostics!.facts!;
  // The doctor's workbuddy-ioa-edition check reads `edition`.
  expect(facts({ models: [{ value: "hy3" }, { value: "claude-4.5-ioa" }], efforts: [] }).edition).toBe("ioa");
  expect(facts({ models: [{ value: "hy3" }], efforts: [] }).edition).toBe("public");
  expect(facts({ models: [], efforts: [] })).toMatchObject({ edition: "unknown", internetEnvironment: expect.any(String) });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-logs-"));
  for (const [name, at] of [["a__1.log", 1], ["b__2.log", 3], ["desktop__3.log", 4], ["c__4.log", 2], ["notes.txt", 5]] as const) {
    fs.writeFileSync(path.join(dir, name), "");
    fs.utimesSync(path.join(dir, name), at, at);
  }
  expect(newestLogs(dir, (name) => name.endsWith(".log") && !name.startsWith("desktop__"))).toEqual([path.join(dir, "b__2.log"), path.join(dir, "c__4.log")]);
  expect(newestLogs(path.join(dir, "gone"), () => true)).toEqual([]);
});

it("a refused turn's reason comes out of CodeBuddy's _meta, upstream words first", () => {
  const meta = (error: unknown) => ({ stopReason: "refusal", _meta: { "codebuddy.ai/errorMessage": JSON.stringify(error) } });
  expect(codebuddyFailure(meta({ code: -32603, message: "Internal error", data: { details: "401 endpoint mismatch", statusCode: 401, category: "internal" } }))).toBe("401 endpoint mismatch");
  expect(codebuddyFailure(meta({ code: -32010, message: "Quota exceeded: no credits left", data: { details: "no credits left", category: "quota" } }))).toBe("Quota exceeded: no credits left");
  expect(codebuddyFailure(meta({ code: -32603, message: "Network error: ECONNRESET", data: { details: "socket closed" } }))).toBe("Network error: ECONNRESET — socket closed");
  expect(codebuddyFailure({ stopReason: "refusal", errorMessage: "This message looks sensitive" })).toBe("This message looks sensitive");
  expect(codebuddyFailure({ stopReason: "refusal", _meta: { errorMessage: "Agent did not return to idle" } })).toBe("Agent did not return to idle");
  expect(codebuddyFailure({ stopReason: "refusal" })).toBeUndefined();
});

describe("connecting WorkBuddy's own sessions to Tomrade", () => {
  const link = (workbuddyMcpLink as Extract<typeof workbuddyMcpLink, { cli: unknown }>).cli;

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-workbuddy-link-"));
    const config = path.join(dir, "config");
    fs.mkdirSync(config);
    process.env.CODEBUDDY_CONFIG_DIR = config;
    const cli = fakeCli(fakeCodebuddy(dir, "fake-codebuddy-mcp.mjs"));
    const file = path.join(config, ".mcp.json");
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    return { cli, file, read };
  }

  it("finds CodeBuddy's user-scope file under CODEBUDDY_CONFIG_DIR, else ~/.codebuddy", () => {
    expect(codebuddyUserFile({ CODEBUDDY_CONFIG_DIR: "/x/cb" })).toBe(path.join("/x/cb", ".mcp.json"));
    expect(codebuddyUserFile({})).toBe(path.join(os.homedir(), ".codebuddy", ".mcp.json"));
  });

  it("adds, keeps, updates and removes a user-scope tomrade server with `codebuddy mcp`, leaving the rest of .mcp.json alone", async () => {
    const { cli, file, read } = setup();
    const url = MCP.url;
    expect(link.file()).toBe(file);
    expect(link.configuredUrl()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } }, disabledMcpServers: [] }));
    expect(link.configuredUrl()).toBeNull();

    expect(link.add(url)).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "tomrade", url]);
    expect(link.remove()).toEqual(["mcp", "remove", "--scope", "user", "tomrade"]);
    expect((await cli.run(link.add(url))).code).toBe(0);
    expect(read()).toMatchObject({ mcpServers: { other: { command: "x" }, tomrade: { type: "http", url } } });
    expect(link.configuredUrl()).toBe(url);

    // Another address is stale until it is added again, which replaces it.
    fs.writeFileSync(file, JSON.stringify({ ...read(), mcpServers: { ...read().mcpServers, tomrade: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
    expect(link.configuredUrl()).toBe("http://127.0.0.1:1/mcp");
    expect((await cli.run(link.add(url))).code).toBe(0);
    expect(link.configuredUrl()).toBe(url);

    expect((await cli.run(link.remove())).code).toBe(0);
    expect(link.configuredUrl()).toBeNull();
    expect(read()).toMatchObject({ mcpServers: { other: { command: "x" } } });
    expect(read().mcpServers.tomrade).toBeUndefined();
  });

  it("keeps the state as it was when `codebuddy mcp` fails", async () => {
    const { cli } = setup();
    process.env.FAKE_MCP_FAIL = "1";
    const run = await cli.run(link.add(MCP.url));
    expect(run).toMatchObject({ code: 1, stderr: expect.stringContaining("fake failure") });
    expect(link.configuredUrl()).toBeNull();
  });

  it("throws on a file it cannot read, which Tomrade shows instead of a state", () => {
    const { file } = setup();
    fs.writeFileSync(file, "{ not json");
    expect(() => link.configuredUrl()).toThrow();
  });
});

describe("CodeBuddy answering worker calls", () => {
  function setup(options: { model?: string; effort?: string } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codebuddy-lent-"));
    const log = path.join(dir, "log.jsonl");
    const cli = fakeCli(fakeCodebuddy(dir, "fake-codebuddy-lent.mjs", `TOMRADE_TEST_LOG='${log}' `));
    const ask = workbuddy.lend!.ask;
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
    return { log, calls, ask: (user: string) => ask({ system: "Reply in JSON.", transcript: user }, io(cli, { command: "codebuddy", ...options })) };
  }

  it("asks CodeBuddy bare: no tools, MCP, settings, memory or saved session, the instructions in a file", async () => {
    const { ask } = setup({ model: "deepseek-v4.1-flash", effort: "low" });
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; env: Record<string, string> };
    expect(echoed.args.slice(0, 11)).toEqual(["-p", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", expect.stringMatching(/tomrade-codebuddy-lent-.*system\.md$/)]);
    expect(echoed.args.slice(11)).toEqual(["--model", "deepseek-v4.1-flash", "--effort", "low"]);
    expect(echoed.system).toBe("Reply in JSON.");
    expect(echoed.prompt).toBe("plan it");
    expect(echoed.env).toMatchObject({ CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1", CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" });
    expect(out).toEqual({ text: out.text, inputTokens: 52, cacheReadTokens: 40, outputTokens: 3 });
    // the instructions file goes with the call
    expect(fs.existsSync(path.dirname(echoed.args[10]!))).toBe(false);

    await expect(ask("FAIL")).rejects.toThrow(/WorkBuddy could not answer: 400 model \[nope\]/);
  }, 30_000);

  it("says it is not signed in while CodeBuddy says so, and how to sign in", async () => {
    const { log, calls, ask } = setup();
    fs.writeFileSync(log + ".signed-out", "");
    const failed = ask("plan it");
    await expect(failed).rejects.toThrow(/WorkBuddy is not signed in \(Authentication required.*\) — run `codebuddy` and \/login with your WorkBuddy account/);
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
    expect(calls()).toHaveLength(1);
  }, 30_000);

  it("uses the model the person last picked in CodeBuddy when Tomrade names none", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-home-"));
    expect(ownModel(home)).toBeUndefined();
    fs.mkdirSync(path.join(home, ".codebuddy"));
    fs.writeFileSync(path.join(home, ".codebuddy", "settings.json"), JSON.stringify({ model: "hy3", trustedDirectories: [] }));
    expect(ownModel(home)).toBe("hy3");
  });
});
