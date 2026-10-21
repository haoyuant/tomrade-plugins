import type { LocalAgentSpec } from "@tomradex/plugin-sdk";
import { agyAsk } from "./lend.js";
import { agyMcpLink } from "./link.js";

/**
 * Antigravity's CLI (`agy`), Google's successor to Gemini CLI. It has no ACP
 * and no per-session MCP flag, and its config takes no `${VAR}` in a header,
 * so Tomrade starts it only in a terminal, where its own user-level `tomrade`
 * server (tokenless) reaches Tomrade and its first act is claim_ticket.
 */
export const agy: LocalAgentSpec = {
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
  picks: [
    { key: "model", title: "Model", choices: [], freeText: true },
    { key: "effort", title: "Effort", choices: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value })) }
  ],
  mcpLink: agyMcpLink,
  // Every call carries agy's own tool definitions (about 12k tokens).
  lend: { rank: 75, ask: agyAsk }
};
