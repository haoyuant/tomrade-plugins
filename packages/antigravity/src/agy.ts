import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { agyAsk } from "./lend.js";
import { agyMcpLink } from "./link.js";

export const AgyOptions = z.object({
  /** The ACP server Google ships, as the ACP registry names it: `agy_acp_server.par` (`agy_acp_server.exe` on Windows). */
  command: z.string().default(process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"),
  /** A model as agy takes it; empty keeps its own. */
  model: z.string().optional(),
  /** low, medium, high, xhigh or max; empty keeps its own. */
  effort: z.string().optional()
});
export type AgyOptions = z.infer<typeof AgyOptions>;

/**
 * Antigravity CLI (`agy`), Google's successor to Gemini CLI. Its own `agy acp`
 * does not exist; Google ships a separate ACP server, `agy_acp_server.par`
 * (`agy_acp_server.exe` on Windows), which takes Tomrade's HTTP MCP server as
 * advertised in `initialize`. A ticket can also be handed to `agy` in a
 * terminal, where its own user-level `tomrade` server (tokenless) reaches
 * Tomrade and its first act is claim_ticket.
 */
export const agy: LocalAgentSpec<AgyOptions> = {
  id: "agy",
  title: "Antigravity CLI",
  cli: { name: "agy", desktopApp: { title: "Antigravity", mac: ["Antigravity"], windows: ["Programs\\Antigravity"] } },
  install: "install the Antigravity CLI ({install}) and sign in",
  setup: {
    install: [process.platform === "win32"
      ? { powershell: "https://antigravity.google/cli/install.ps1" }
      : { script: "https://antigravity.google/cli/install.sh" }],
    signIn: "agy",
    signInRuns: true,
    docs: "https://antigravity.google/docs/cli",
    // The IDE's opt-in command line tool is `agy-ide`, not `agy`.
    download: "https://antigravity.google/download",
    desktop: { title: "Antigravity", shipsCli: false }
  },
  options: AgyOptions,
  acp: {
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] },
    // The ACP server Google ships from https://dl.google.com/agy-extensions/releases/ is started as it is, with no arguments.
    args: () => [],
    reopen: "load",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // A ticket can also go to `agy` in a terminal, reaching Tomrade through `agy mcp add`.
    terminal: { via: "link" }
  },
  mcpLink: agyMcpLink,
  // Every call carries agy's own tool definitions (about 12k tokens).
  lend: { rank: 75, ask: agyAsk }
};
