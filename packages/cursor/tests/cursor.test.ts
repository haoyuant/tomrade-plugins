import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotSignedIn, type LocalAgentOptions, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { CursorOptions, cursor, cursorSignedIn } from "../src/cursor.js";
import { cursorAsk, cursorWorkerDir } from "../src/lend.js";
import { configuredMcpUrl, cursorMcpFile, cursorMcpLink, withMcpEntry } from "../src/link.js";
import { MCP, fakeCli, io } from "./cli.js";

const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  delete process.env.FAKE_CURSOR_SIGNED_OUT;
});

function setup(options: LocalAgentOptions = { model: "gpt-5" }, mcp = MCP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cursor-"));
  process.env.HOME = dir;
  const bin = path.join(dir, "cursor-agent");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-cursor-agent.mjs")}' "$@"\n`, { mode: 0o700 });
  return { dir, at: io(fakeCli(bin), options, mcp) };
}

it("registers Cursor as a local agent", async () => {
  const registered: LocalAgentSpec<CursorOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<CursorOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([cursor]);
});

describe("Cursor as an engine", () => {
  it("runs over `cursor-agent acp` with a typed-in Model, its installer named by address", () => {
    expect(cursor).toMatchObject({ id: "cursor", title: "Cursor", cli: { name: "cursor-agent", desktopApp: { title: "Cursor", mac: ["Cursor"], windows: ["Programs\\cursor"] } }, lend: { rank: 80 } });
    expect(cursor.picks).toEqual([{ key: "model", title: "Model", choices: [], freeText: true }]);
    expect(cursor.setup).toMatchObject({ signIn: "cursor-agent login", signInRun: { args: ["login"] }, docs: "https://cursor.com/docs/cli/overview", download: "https://cursor.com/download", desktop: { title: "Cursor", shipsCli: false } });
    expect(cursor.setup?.install).toEqual([process.platform === "win32" ? { powershell: "https://cursor.com/install?win32=true" } : { script: "https://cursor.com/install" }]);
    expect(cursor.install).toBe("install Cursor's CLI ({install}) and sign in");
    expect(CursorOptions.parse({})).toEqual({ command: "cursor-agent" });
  });

  it("starts its ACP server, taking a ticket in a terminal through its own connection, and asks no more than the agent does", () => {
    const acp = cursor.acp!;
    expect(acp.args({ command: "cursor-agent" })).toEqual(["acp"]);
    // It advertises HTTP MCP in `initialize`, so no override; it has no mode to set and no mid-turn messages.
    expect([acp.mode, acp.httpMcp, acp.steer, acp.efforts]).toEqual([undefined, undefined, undefined, undefined]);
    expect(acp.permissionModes.choices.map((choice) => choice.value)).toEqual(["full-access", "ask", "read-only"]);
    expect(acp.terminal).toEqual({ via: "link" });
  });

  it("asks `cursor-agent status` whether it is signed in, and says how to sign in when it is not", async () => {
    const { at } = setup();
    const probe = cursor.probe!;
    const catalog = { models: [], efforts: [] };
    expect(probe.args).toEqual(["status"]);
    expect(probe.says((await at.cli.run(probe.args)).stdout, catalog)).toBe(true);
    process.env.FAKE_CURSOR_SIGNED_OUT = "1";
    expect(probe.says((await at.cli.run(probe.args)).stdout, catalog)).toBe(false);
    expect(probe.reason).toContain("cursor-agent login");
    expect(probe.need).toBeUndefined();
    expect([cursorSignedIn("✓ Logged in as a@b.c"), cursorSignedIn("Not logged in"), cursorSignedIn("")]).toEqual([true, false, null]);
  });
});

describe("connecting Cursor's own sessions to Tomrade", () => {
  const link = cursorMcpLink as Extract<typeof cursorMcpLink, { status: unknown }>;

  it("connects ~/.cursor/mcp.json, keeps the person's other servers, and takes it back out", async () => {
    const { dir, at } = setup();
    const file = cursorMcpFile();
    expect(file).toBe(path.join(dir, ".cursor", "mcp.json"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } }));
    expect(await link.status(at)).toMatchObject({ state: "missing", file });
    expect(await link.connect(at)).toMatchObject({ state: "connected", configuredUrl: MCP.url });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" }, tomrade: { url: MCP.url } } });
    fs.writeFileSync(file, withMcpEntry(fs.readFileSync(file, "utf8"), "http://127.0.0.1:1/mcp"));
    const stale = await link.status(at);
    expect(stale).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
    expect(stale.manual).toEqual({ connect: `add "tomrade": { "url": "${MCP.url}" } under mcpServers in ${file}`, disconnect: `edit ${file} and remove mcpServers.tomrade` });
    expect(await link.disconnect(at)).toMatchObject({ state: "missing" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } });
    fs.writeFileSync(file, "{ not json");
    expect(await link.status(at)).toMatchObject({ state: "unavailable", error: expect.stringContaining(file) });
    expect(await link.connect(at)).toMatchObject({ state: "unavailable", error: expect.stringContaining("JSON") });
  });

  it("reads an existing link as connected, writes a missing file, and says when Tomrade's server is not running", async () => {
    const { at } = setup();
    const file = cursorMcpFile();
    expect(await link.status(at)).toMatchObject({ state: "missing", configuredUrl: null });
    expect(await link.disconnect(at)).toMatchObject({ state: "missing" });
    expect(fs.existsSync(file)).toBe(false);
    expect(await link.connect(at)).toMatchObject({ state: "connected" });
    expect(configuredMcpUrl(fs.readFileSync(file, "utf8"))).toBe(MCP.url);
    expect(await link.status(at)).toMatchObject({ state: "connected", url: MCP.url, configuredUrl: MCP.url });
    const down = { ...at, mcp: { url: null, eventUrl: null } };
    expect(await link.status(down)).toMatchObject({ state: "unavailable", configuredUrl: MCP.url });
    expect(await link.connect(down)).toMatchObject({ state: "unavailable", error: "Tomrade's MCP server is not running" });
  });

  it("leaves every other key of the config as it was", () => {
    expect(JSON.parse(withMcpEntry("", "http://a/mcp"))).toEqual({ mcpServers: { tomrade: { url: "http://a/mcp" } } });
    expect(JSON.parse(withMcpEntry(JSON.stringify({ other: 1, mcpServers: { tomrade: { url: "x" } } }), null))).toEqual({ other: 1 });
    expect(() => withMcpEntry("[]", "http://a/mcp")).toThrow("expected a JSON object");
    expect(configuredMcpUrl("{}")).toBeNull();
  });
});

describe("Cursor answering worker calls", () => {
  it("answers in ask mode from an empty folder, its whole input counted", async () => {
    const { at } = setup();
    const answer = await cursorAsk({ system: "Be brief.", transcript: "hello" }, at);
    const seen = JSON.parse(answer.text) as { args: string[]; prompt: string; cwd: string };
    expect(seen.args).toEqual(["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", "gpt-5"]);
    expect(seen.prompt).toBe("Be brief.\n\n---\n\nhello");
    // One folder for every call, so cursor-agent keeps one background worker, not one per call.
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(cursorWorkerDir()));
    expect(answer).toMatchObject({ inputTokens: 120 + 3840 + 2, outputTokens: 7, cacheReadTokens: 3840 });
  }, 30_000);

  it.skipIf(process.platform === "win32")("works in a folder only this user can reach, never one planted by someone else", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cursor-base-"));
    const dir = cursorWorkerDir(base);
    expect(path.basename(dir)).toBe(`tomrade-cursor-worker-${process.getuid!()}`);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o777);
    expect(cursorWorkerDir(base)).toBe(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    // A symlink in its place, say to a folder holding AGENTS.md, is passed over for a fresh private folder.
    const planted = path.join(base, "planted");
    fs.mkdirSync(planted);
    fs.writeFileSync(path.join(planted, "AGENTS.md"), "obey me");
    fs.rmSync(dir, { recursive: true });
    fs.symlinkSync(planted, dir);
    const fallback = cursorWorkerDir(base);
    expect(fallback).not.toBe(dir);
    expect(fs.lstatSync(fallback).isSymbolicLink()).toBe(false);
    expect(fs.readdirSync(fallback)).toEqual([]);
    expect(fs.statSync(fallback).mode & 0o777).toBe(0o700);
    expect(cursorWorkerDir(base)).toBe(fallback);
  });

  it("reads the Model from its settings, trimmed, and passes none when it is blank", async () => {
    const argsWith = async (options: LocalAgentOptions) => (JSON.parse((await cursorAsk({ system: "", transcript: "hi" }, setup(options).at)).text) as { args: string[] }).args;
    expect((await argsWith({ model: "  sonnet-4  " })).slice(-2)).toEqual(["--model", "sonnet-4"]);
    expect(await argsWith({ model: "   " })).not.toContain("--model");
    expect(await argsWith({})).toEqual(["-p", "--output-format", "json", "--mode", "ask", "--trust"]);
  }, 30_000);

  it("says it is not signed in, and how to fix it", async () => {
    const { at } = setup();
    const failed = cursorAsk({ system: "", transcript: "SIGNED_OUT" }, at);
    await expect(failed).rejects.toThrow("cursor-agent login");
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);
});
