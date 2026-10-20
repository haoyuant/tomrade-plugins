import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { NotSignedIn } from "@tomradex/plugin-sdk";
import { DSH_LENT_PLUGIN, dshAsk, dshSelection, dshWorkerDir } from "../src/lend.js";
import { fakeCli, io } from "./cli.js";

function setup(options: { model?: string; effort?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-dsh-lent-"));
  const bin = path.join(dir, "dsh");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve(import.meta.dirname, "fake-dsh-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  const at = io(fakeCli(bin), { command: "dsh", ...options });
  return { ask: (user: string) => dshAsk({ system: "Reply in JSON {{like this}}.", transcript: user }, at) };
}

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tomrade-dsh-lent-"));

it("asks dsh headless through a patch for this run alone: the call's prompt as the whole system prompt, no tools, its session kept apart", async () => {
  const before = leftovers();
  const { ask } = setup({ model: "deepseek-v4-pro", effort: "low" });
  const out = await ask("plan it");
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; cwd: string; call: { system: string; selection: object }; patch: string; plugin: string };
  expect(echoed.args.slice(0, 3)).toEqual(["--profile", "headless", "--patch"]);
  expect(echoed.args.slice(4)).toEqual(["--json", "-"]);
  expect(echoed.prompt).toBe("plan it");
  expect(fs.realpathSync(echoed.cwd)).toBe(fs.realpathSync(dshWorkerDir()));
  expect(echoed.call).toEqual({ system: "Reply in JSON {{like this}}.", selection: { model: "deepseek-v4-pro", reasoningEffort: "low" } });
  for (const id of ["session-title-llm", "skill", "skill-filesystem", "tool-skill", "agent-instructions"]) expect(echoed.patch).toContain(`- id: ${id}\n  disabled: true`);
  expect(echoed.patch).toMatch(/- insert:\n {4}- id: tomrade-lent\n {6}name: ".*lent\.mjs"/);
  expect(echoed.plugin).toBe(DSH_LENT_PLUGIN);
  expect(out).toEqual({ text: out.text, inputTokens: 1975 + 169 + 7040 + 5, outputTokens: 41, cacheReadTokens: 7040 });
  // the run's folder, its session included, is gone
  expect(leftovers()).toEqual(before);
}, 30_000);

it("names the provider only when the model does", () => {
  expect(dshSelection({})).toEqual({});
  expect(dshSelection({ model: " deepseek-v4-pro " })).toEqual({ model: "deepseek-v4-pro" });
  expect(dshSelection({ model: "openrouter/qwen3-coder", effort: "max" })).toEqual({ provider: "openrouter", model: "qwen3-coder", reasoningEffort: "max" });
});

it("is not signed in without a DeepSeek account or key, says how to add one, and passes on any other failure", async () => {
  const { ask } = setup();
  const failed = ask("FAIL");
  await expect(failed).rejects.toThrow("DeepSeek Harness could not answer: llm-deepseek: 402 Insufficient Balance");
  await expect(failed).rejects.not.toBeInstanceOf(NotSignedIn);
  const signedOut = ask("SIGNED_OUT");
  await expect(signedOut).rejects.toThrow(/DeepSeek Harness has no DeepSeek account or API key \(llm-deepseek: no API key .*\) — sign in or add a key under Settings → Models/);
  await expect(signedOut).rejects.toBeInstanceOf(NotSignedIn);
}, 30_000);
