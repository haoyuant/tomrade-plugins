import { expect, it } from "vitest";
import type { LocalAgentSpec, PluginContext } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import { DshOptions, dsh, dshDesktopApps } from "../src/dsh.js";

it("registers DeepSeek Harness as a local agent", async () => {
  const registered: LocalAgentSpec<DshOptions>[] = [];
  const ctx = { agent: { localAgent: async (spec: LocalAgentSpec<DshOptions>) => (registered.push(spec), () => {}) } } as unknown as PluginContext;
  await (plugin as unknown as { apply(ctx: PluginContext): Promise<void> }).apply(ctx);
  expect(registered).toEqual([dsh]);
});

it("boots dsh's acp profile and offers its reasoning efforts before a session has listed them", () => {
  const acp = dsh.acp!;
  expect(acp.args({ command: "dsh" })).toEqual(["--profile", "acp"]);
  expect(acp.mode).toBeUndefined();
  expect(dsh.cli.name).toBe("dsh");
  expect(dsh).toMatchObject({ id: "dsh", title: "DeepSeek Harness", lend: { rank: 45 } });
  expect(acp.permissionModes.choices.map((choice) => choice.value)).toEqual(["full-access", "local"]);
  expect(acp.permissionModes.default).toBe("full-access");
  expect(acp.efforts).toEqual(["off", "low", "high", "max"]);
  expect(acp.terminal).toBe(true);
  expect(acp).not.toHaveProperty("terminalViaLink");
  expect(dsh.mcpLink).toBeUndefined();
  expect(DshOptions.parse({})).toEqual({ command: "dsh" });
});

const noInstalls = async () => [];

it("goes by DeepSeek Harness, still as the dsh engine, and points at the official page", () => {
  expect(dsh).toMatchObject({ id: "dsh", title: "DeepSeek Harness" });
  expect(dsh.setup).toMatchObject({ install: [{ npm: "@deepseek-ai/dsh" }], signIn: "dsh web", signInRuns: true, docs: "https://www.deepseek.com/en/harness/", download: "https://www.deepseek.com/en/harness/", desktop: { title: "DeepSeek Harness", shipsCli: true } });
  expect(dsh.install).toContain("desktop app");
  // The app writes the first install, as a command, where the words say {install}: the same words as before.
  expect(dsh.install.replace("{install}", "npm install -g @deepseek-ai/dsh")).toBe(
    "install the DeepSeek Harness desktop app (deepseek.com/en/harness), or its CLI with npm install -g @deepseek-ai/dsh, and sign in or add a DeepSeek API key"
  );
  expect(dsh.signIn).toContain("DEEPSEEK_API_KEY");
});

it("knows where the DeepSeek Harness desktop app keeps its dsh launcher", async () => {
  expect(await dshDesktopApps({ platform: "darwin", env: {}, home: "/Users/a", installs: noInstalls })).toEqual([
    { file: "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" },
    { file: "/Users/a/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" }
  ]);
  const win = await dshDesktopApps({ platform: "win32", env: { LocalAppData: "C:\\Users\\a\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, home: "C:\\Users\\a",
    installs: async (name) => (name.test("DeepSeek Harness") ? ["D:\\Apps\\DSH"] : []) });
  expect(win.map((app) => app.file)).toEqual([
    "D:\\Apps\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
    "C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd",
    "C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"
  ]);
  // The launcher runs itself with the app's runtime: no separate binary to hand it to.
  expect(win.every((app) => app.runtime === undefined)).toBe(true);
  // A failing installed-apps list still leaves the usual folders.
  const unlisted = await dshDesktopApps({ platform: "win32", env: {}, home: "C:\\Users\\a", installs: async () => { throw new Error("no registry"); } });
  expect(unlisted.map((app) => app.file)).toEqual(["C:\\Users\\a\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd"]);
  expect(await dshDesktopApps({ platform: "linux", env: {}, home: "/home/a", installs: noInstalls })).toEqual([]);
});
