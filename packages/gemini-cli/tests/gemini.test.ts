import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotSignedIn, type LocalAgentSpec, type PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { GEMINI_SIGN_IN, geminiCanSignIn } from "../src/auth.js";
import { GeminiOptions, gemini, geminiCallName } from "../src/gemini.js";
import { geminiAsk, ownModel } from "../src/lend.js";
import { fakeCli, io } from "./cli.js";

it("registers Gemini CLI as a local agent", async () => {
  const registered: LocalAgentSpec<GeminiOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<GeminiOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([gemini]);
});

it("registers Gemini CLI as an in-app agent that also takes a ticket in a terminal", () => {
  const acp = gemini.acp!;
  expect(gemini).toMatchObject({ id: "gemini", title: "Gemini CLI", cli: { name: "gemini" }, lend: { rank: 40 } });
  expect(gemini.setup).toEqual({ install: [{ npm: "@google/gemini-cli" }], signIn: "gemini", signInRuns: true, docs: "https://github.com/google-gemini/gemini-cli", download: "https://geminicli.com/docs/get-started/installation/" });
  expect(gemini.install.replace("{install}", "npm install -g @google/gemini-cli")).toBe("install Gemini CLI (npm install -g @google/gemini-cli) and sign in");
  expect(acp).toMatchObject({ permissionModes: { default: "full-access" }, reopen: "never", usage: "turn", terminal: true });
  expect(acp.permissionModes.choices.map((c) => c.value)).toEqual(["full-access", "ask", "read-only"]);
  // Tomrade sets it up in the terminal itself: no user-level link of its own, and no mid-turn messages.
  expect([acp.terminalViaLink, acp.steer, acp.mode, acp.httpMcp, acp.efforts, gemini.mcpLink]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
  expect(GeminiOptions.parse({})).toEqual({ command: "gemini" });
  expect(gemini.signIn).toBe(GEMINI_SIGN_IN);
});

it("starts Gemini CLI's ACP server asking before it acts, in a folder it trusts, and names its calls from their ids", () => {
  const acp = gemini.acp!;
  expect(acp.args({ command: "gemini" })).toEqual(["--acp", "--approval-mode", "default"]);
  expect(acp.env?.({ command: "gemini" })).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: "true" });
  expect(acp.callName).toBe(geminiCallName);
  expect(geminiCallName("mcp_tomrade_list_items__a1b2")).toBe("mcp_tomrade_list_items");
  expect(geminiCallName("run_shell_command__run_shell_command_1792_0")).toBe("run_shell_command");
  expect(geminiCallName("opaque-id")).toBeUndefined();
});

it("reads from Gemini CLI's own settings whether it can sign in, now that a personal Google sign-in is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-auth-"));
  const auth = (selectedType?: string) => fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(selectedType ? { security: { auth: { selectedType } } } : {}));
  auth("oauth-personal");
  expect(geminiCanSignIn({}, dir)).toBe(false);
  // A Cloud project means a Code Assist licence, which still signs in with Google.
  expect(geminiCanSignIn({ GOOGLE_CLOUD_PROJECT: "acme" }, dir)).toBeNull();
  auth("gemini-api-key");
  expect(geminiCanSignIn({}, dir)).toBe(false);
  expect(geminiCanSignIn({ GEMINI_API_KEY: "AIza…" }, dir)).toBe(true);
  fs.writeFileSync(path.join(dir, ".env"), "GEMINI_API_KEY=AIzaSyExample\n");
  expect(geminiCanSignIn({}, dir)).toBe(true);
  auth("vertex-ai");
  expect(geminiCanSignIn({}, dir)).toBeNull();
  auth();
  // Not chosen yet, but a key is there: nothing says no.
  expect(geminiCanSignIn({}, dir)).toBeNull();
  fs.rmSync(path.join(dir, ".env"));
  expect(geminiCanSignIn({}, dir)).toBe(false);
  expect(gemini.signedIn?.reason).toContain("personal Google account");
});

it("asks the person's own Gemini CLI settings when Tomrade checks its sign-in", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
  const saved = { GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  try {
    process.env.GEMINI_CLI_HOME = home;
    delete process.env.GEMINI_API_KEY;
    fs.mkdirSync(path.join(home, ".gemini"));
    fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    expect(gemini.signedIn?.ask()).toBe(false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe("Gemini CLI answering worker calls", () => {
  let home = "";
  const saved = { GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, GEMINI_MODEL: process.env.GEMINI_MODEL };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
    process.env.GEMINI_CLI_HOME = home;
    delete process.env.GEMINI_MODEL;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function setup(engine: { model?: string } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-lent-"));
    const log = path.join(dir, "log.jsonl");
    const bin = path.join(dir, "gemini");
    fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-gemini-lent.mjs")}' "$@"\n`, { mode: 0o700 });
    const at = io(fakeCli(bin), GeminiOptions.parse({ command: bin, ...engine }));
    return { log, ask: (user: string) => geminiAsk({ system: "Reply in JSON.", transcript: user }, at) };
  }

  it("asks Gemini CLI bare: its prompt swapped for the call's, no tools, MCP, extensions, skills or hooks", async () => {
    const { ask } = setup();
    const out = await ask("plan it");
    const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; env: Record<string, string>; settings: Record<string, unknown> };
    // Flash, not Auto's classifier call and then Pro
    expect(echoed.args).toEqual(["-p", "", "-o", "stream-json", "-e", "none", "--allowed-mcp-server-names", "tomrade-lent-none", "-m", "flash"]);
    expect(echoed.system).toBe("Reply in JSON.");
    expect(echoed.prompt).toBe("plan it");
    expect(echoed.env).toEqual({ NO_BROWSER: "true", GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SANDBOX: "false" });
    expect(echoed.settings).toMatchObject({ tools: { core: [] }, skills: { enabled: false }, hooksConfig: { enabled: false } });
    expect(out).toEqual({ text: out.text, inputTokens: 42, cacheReadTokens: 30, outputTokens: 7 });
    // the lent session is not kept for resuming; the person's own stay
    expect(fs.readdirSync(path.join(home, ".gemini", "tmp", "tomrade-gemini-lent", "chats"))).toEqual(["session-2026-10-01T09-00-0ther111.jsonl"]);

    await expect(ask("FAIL")).rejects.toThrow(/Gemini CLI could not answer: You have exhausted your daily quota/);
  }, 30_000);

  it("keeps the model the person set, in Tomrade or in Gemini CLI itself", async () => {
    const named = JSON.parse((await setup({ model: "gemini-3.1-pro-preview" }).ask("x")).text) as { args: string[] };
    expect(named.args.slice(-2)).toEqual(["-m", "gemini-3.1-pro-preview"]);
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ model: { name: "gemini-3.8-flash" } }));
    expect(ownModel()).toBe("gemini-3.8-flash");
    const own = JSON.parse((await setup().ask("x")).text) as { args: string[] };
    expect(own.args).not.toContain("-m");
    process.env.GEMINI_MODEL = "pro";
    expect(ownModel(path.join(home, "nowhere"))).toBe("pro");
  }, 30_000);

  it("is not signed in while Gemini CLI cannot sign in without a person, and says how to", async () => {
    const { log, ask } = setup();
    fs.writeFileSync(log + ".signed-out", "");
    const failed = ask("plan it");
    await expect(failed).rejects.toThrow(/Gemini CLI is not signed in \(Manual authorization is required.*\) — run `gemini`, enter \/auth and choose Use Gemini API Key/);
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);

  it("takes Google's refusal of a personal sign-in as not signed in, and points at an API key", async () => {
    const { log, ask } = setup();
    fs.writeFileSync(log + ".personal", "");
    const failed = ask("plan it");
    await expect(failed).rejects.toThrow(/Gemini CLI is not signed in .* Use Gemini API Key .* Settings → Assistant/);
    await expect(failed).rejects.toBeInstanceOf(NotSignedIn);
  }, 30_000);
});
