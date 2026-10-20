import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { hermesAsk } from "./lend.js";
import { hermesMcpLink } from "./link.js";

export const HermesOptions = z.object({
  command: z.string().default("hermes"),
  /** A model id, or `provider:model` to switch provider too; empty keeps Hermes' own default. */
  model: z.string().optional()
});
export type HermesOptions = z.infer<typeof HermesOptions>;

/** `hermes acp --check` imports the ACP adapter, which an install without the `acp` extra lacks. */
export function hermesAcpReady(output: string): boolean | null {
  if (/check ok/i.test(output)) return true;
  if (/ModuleNotFoundError|No module named|ImportError/.test(output)) return false;
  return null;
}

export const hermes: LocalAgentSpec<HermesOptions> = {
  id: "hermes",
  title: "Hermes",
  cli: { name: "hermes" },
  install: "install Hermes Agent ({install}) and run `hermes setup`",
  setup: {
    install: [process.platform === "win32"
      ? { powershell: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1" }
      : { script: "https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh" }],
    signIn: "hermes setup",
    signInRuns: true,
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/acp"
  },
  options: HermesOptions,
  acp: {
    // Non-dangerous commands run without asking whatever the mode, so a read-only turn is not something Hermes can promise.
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] },
    args: () => ["acp"],
    // "default" asks before every edit; dangerous commands are asked about in every mode, and Tomrade answers for the turn.
    mode: (policy) => (policy === "full-access" ? "dont_ask" : "default"),
    // It registers an HTTP server it is handed, though it does not advertise that it can.
    httpMcp: "always",
    // Its `session/resume` opens a fresh session when the old one is gone; `session/load` says so.
    reopen: "load",
    // a `/steer` prompt sent alongside lands after its next tool result (acp_adapter/commands.py)
    steer: "slash",
    // `hermes chat` takes the ticket in a terminal, its tomrade server from config.yaml with this session's token.
    terminal: true,
    terminalViaLink: true,
    usage: "turn"
  },
  signIn: "run `hermes setup` to choose a provider and add its key",
  diagnostics: {
    logs: () => ["errors.log", "agent.log"].map((name) => path.join(process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes"), "logs", name)).filter((file) => fs.existsSync(file))
  },
  probe: {
    args: ["acp", "--check"],
    says: (output) => hermesAcpReady(output),
    reason: "Hermes is installed without its ACP support — run `hermes update`, or reinstall it with the acp extra",
    need: "repair"
  },
  mcpLink: hermesMcpLink,
  // After Pi: Hermes starts a Python runtime for every call.
  lend: { rank: 60, ask: hermesAsk }
};
