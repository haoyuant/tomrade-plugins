import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotSignedIn, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { AgyOptions, agy } from "../src/agy.js";
import { agyAsk, agyDir, agyModel, agyWorkerDir } from "../src/lend.js";
import { agyConfiguredUrl, agyMcpFile, agyMcpLink } from "../src/link.js";
import { MCP, fakeCli, io } from "./cli.js";

let home = "";
const savedHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
});

it("registers Antigravity CLI as a local agent", async () => {
  const registered: LocalAgentSpec<AgyOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<AgyOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([agy]);
});

it("runs Google's ACP server with Model and Effort picks, found beside the Antigravity app, lent after the others", () => {
  expect(agy).toMatchObject({ id: "agy", title: "Antigravity CLI", cli: { name: "agy", desktopApp: { title: "Antigravity", mac: ["Antigravity"], windows: ["Programs\\Antigravity"] } }, lend: { rank: 75 } });
  // An ACP engine's picks come from its sessions; the settings form asks only which server to start.
  expect(agy.picks).toBeUndefined();
  expect(agy.acp!.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  const server = AgyOptions.parse({}).command;
  expect(agy.install).toBe(`download ${server} from Google's ACP releases ({install})`);
  expect(agy.setup).toMatchObject({ signIn: "agy", signInRuns: true, docs: "https://antigravity.google/docs/cli", download: "https://antigravity.google/download", desktop: { title: "Antigravity", shipsCli: false } });
});

it("starts `agy_acp_server.par` with no arguments, keeps a ticket in the terminal, and asks no more than the agent does", () => {
  const acp = agy.acp!;
  expect(acp.args(AgyOptions.parse({}))).toEqual([]);
  expect(AgyOptions.parse({}).command).toBe(process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par");
  expect(AgyOptions.parse({ command: "/opt/agy_acp_server.par", model: "gemini-3.5-flash", effort: "high" })).toEqual({ command: "/opt/agy_acp_server.par", model: "gemini-3.5-flash", effort: "high" });
  // It advertises HTTP MCP in `initialize`, so no override; no mode to set and no mid-turn messages.
  expect([acp.httpMcp, acp.mode, acp.steer]).toEqual([undefined, undefined, undefined]);
  // Non-dangerous commands run without asking, so it cannot promise a read-only turn.
  expect(acp.permissionModes.choices.map((choice) => choice.value)).toEqual(["full-access", "ask"]);
  expect(acp).toMatchObject({ reopen: "load", efforts: ["low", "medium", "high", "xhigh", "max"], terminal: { via: "link" } });
  expect(agy.probe).toBeUndefined();  expect(agy.signedIn).toBeUndefined();
});

it("answers its permission prompt in a terminal with Enter for the yes it opens on, Esc for no", () => {
  expect(agy.approval).toEqual({ allow: ["enter"], deny: ["esc"] });
});

describe("installing it", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
    vi.resetModules();
  });
  const on = async (name: string, processor: string) => {
    Object.defineProperty(process, "platform", { ...platform, value: name });
    Object.defineProperty(process, "arch", { ...arch, value: processor });
    vi.resetModules();
    return (await import("../src/agy.js")).agy;
  };
  const zip = (url: string, os: string, processor: string, file: string) => ({ archive: { url, file, platform: { os, arch: processor } } });
  const base = "https://dl.google.com/agy-extensions/releases";
  const script = { script: "https://antigravity.google/cli/install.sh" };
  const powershell = { powershell: "https://antigravity.google/cli/install.ps1" };

  it("unpacks Google's ACP server first, so a conversation opens, then runs Antigravity's own installer for `agy`", async () => {
    const set = async (name: string, processor: string) => (await on(name, processor)).setup!.install;
    expect(await set("darwin", "arm64")).toEqual([zip(`${base}/macos/agy-acp-server-1.4.1-darwin-arm64.zip`, "darwin", "arm64", "agy_acp_server.par"), script]);
    expect(await set("darwin", "x64")).toEqual([zip(`${base}/macos/agy-acp-server-1.4.1-darwin-x86_64.zip`, "darwin", "x64", "agy_acp_server.par"), script]);
    expect(await set("linux", "x64")).toEqual([zip(`${base}/linux/agy-acp-server-1.4.1-linux-x86_64.zip`, "linux", "x64", "agy_acp_server.par"), script]);
    expect(await set("linux", "arm64")).toEqual([zip(`${base}/linux/agy-acp-server-1.4.1-linux-arm64.zip`, "linux", "arm64", "agy_acp_server.par"), script]);
    expect(await set("win32", "x64")).toEqual([zip(`${base}/windows/agy-acp-server-1.4.1-windows-x86_64.zip`, "win32", "x64", "agy_acp_server.exe"), powershell]);
    expect(await set("win32", "arm64")).toEqual([zip(`${base}/windows/agy-acp-server-1.4.1-windows-arm64.zip`, "win32", "arm64", "agy_acp_server.exe"), powershell]);
  });

  it("installs only `agy` where Google publishes no server, and says which file setup is missing", async () => {
    // No zip for these, so setup offers none rather than a step that fails.
    expect((await on("linux", "ia32")).setup!.install).toEqual([script]);
    expect((await on("darwin", "arm")).setup!.install).toEqual([script]);
    // The file "not found" names is the server, and `{install}` stands for its zip.
    expect((await on("darwin", "arm64")).install).toBe("download agy_acp_server.par from Google's ACP releases ({install})");
    expect((await on("win32", "ia32")).install).toBe("download agy_acp_server.exe from Google's ACP releases ({install})");
  });
});

describe("connecting agy's own sessions to Tomrade", () => {
  // Stands in for `agy mcp add|remove` as 1.4.0 does it: servers in ~/.gemini/config/mcp_config.json, `serverUrl` for http.
  function fakeAgy(): string {
    const bin = path.join(home, "agy");
    fs.writeFileSync(bin, `#!/bin/sh
f="$HOME/.gemini/config/mcp_config.json"
[ "$1" = "--version" ] && { echo 1.4.0; exit 0; }
mkdir -p "$(dirname "$f")"
if [ "$2" = "add" ]; then printf '{"mcpServers":{"%s":{"serverUrl":"%s","disabled":false}}}' "$3" "$4" > "$f"; else printf '{"mcpServers":{}}' > "$f"; fi
`, { mode: 0o700 });
    return bin;
  }
  const link = (agyMcpLink as Extract<typeof agyMcpLink, { cli: unknown }>).cli;

  it("adds and removes a tokenless tomrade server with `agy mcp`, read back from its config", async () => {
    const cli = fakeCli(fakeAgy());
    expect(agyMcpFile(home)).toBe(path.join(home, ".gemini", "config", "mcp_config.json"));
    expect(link.file()).toBe(agyMcpFile(home));
    expect(link.configuredUrl()).toBeNull();

    expect(link.add(MCP.url)).toEqual(["mcp", "add", "tomrade", MCP.url]);
    expect(await cli.run(link.add(MCP.url))).toMatchObject({ code: 0 });
    expect(link.configuredUrl()).toBe(MCP.url);
    expect(JSON.parse(fs.readFileSync(agyMcpFile(home), "utf8")).mcpServers.tomrade.serverUrl).toBe(MCP.url);

    expect(link.remove()).toEqual(["mcp", "remove", "tomrade"]);
    expect(await cli.run(link.remove())).toMatchObject({ code: 0 });
    expect(link.configuredUrl()).toBeNull();
  });

  it("names no address for a server that is not Tomrade's or has none, and throws on a file it cannot read", () => {
    const file = agyMcpFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { github: { serverUrl: "https://example.com/mcp" }, tomrade: { command: "npx" } } }));
    expect(agyConfiguredUrl(file)).toBeNull();
    fs.writeFileSync(file, "{");
    expect(() => agyConfiguredUrl(file)).toThrow();
  });
});

describe("agy answering worker calls", () => {
  function ask(user: string, options: { model?: string } = {}, system = "Reply in JSON.") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-lent-"));
    const bin = path.join(dir, "agy");
    fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-agy-lent.mjs")}' "$@"\n`, { mode: 0o700 });
    return agyAsk({ system, transcript: user }, io(fakeCli(bin), options));
  }

  it("asks agy in print mode from an empty folder, the instructions leading the prompt, and forgets the conversation", async () => {
    const out = await ask("plan it", { model: "gemini-3.5-flash" });
    const echoed = JSON.parse(out.text) as { args: string[]; event: string; role: string; prompt: string; cwd: string };
    expect(echoed.args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--model", "gemini-3.5-flash"]);
    expect(echoed).toMatchObject({ event: "user", role: "user", prompt: "Reply in JSON.\n\n---\n\nplan it" });
    expect(fs.realpathSync(echoed.cwd)).toBe(fs.realpathSync(agyWorkerDir()));
    expect(out).toMatchObject({ inputTokens: 11784, outputTokens: 62, cacheReadTokens: 40 });
    // the lent conversation is gone; the person's own stays
    const dir = agyDir(home);
    expect(fs.readdirSync(path.join(dir, "conversations"))).toEqual(["0ther111-0000-4000-8000-000000000000.db"]);
    expect(fs.readdirSync(path.join(dir, "brain"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "annotations"))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, "presence"))).toEqual([]);

    const bare = JSON.parse((await ask("x", {}, "")).text) as { args: string[]; prompt: string };
    expect(bare.args).not.toContain("--model");
    expect(bare.prompt).toBe("x");
  }, 30_000);

  it("reads the model from its settings, trimmed, as the built-in did", () => {
    expect(agyModel({ model: "  gemini-3.5-flash " })).toBe("gemini-3.5-flash");
    expect(agyModel({ model: "  " })).toBeUndefined();
    expect(agyModel({})).toBeUndefined();
    expect(agyModel({ model: 3 } as unknown as { model: string })).toBeUndefined();
  });

  it("says what agy tried when it denied itself a tool and gave no answer", async () => {
    await expect(ask("DENIED")).rejects.toThrow("Antigravity CLI could not answer: it tried to use command, which a lent call may not");
  }, 30_000);

  it("says it is not signed in while agy is signed out, and how to sign in", async () => {
    const failed = ask("SIGNED_OUT");
    await expect(failed).rejects.toThrow("Antigravity CLI is not signed in — run `agy` and sign in");
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);
});
