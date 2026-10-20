import type { LocalAgentSpec } from "@tomradex/plugin-sdk";
import { cursorAsk } from "./lend.js";
import { cursorMcpLink } from "./link.js";

/** `cursor-agent status` prints "✓ Logged in as …" or "Not logged in". */
export function cursorSignedIn(output: string): boolean | null {
  if (/not logged in/i.test(output)) return false;
  return /logged in/i.test(output) ? true : null;
}

/**
 * Cursor's CLI (`cursor-agent`). Cursor has no ACP and no per-session MCP
 * flag, so Tomrade starts it only in a terminal, where its user-level
 * `tomrade` server (tokenless) reaches Tomrade and its first act is
 * claim_ticket; a connected repository's `.cursor/hooks.json` reports the rest.
 */
export const cursor: LocalAgentSpec = {
  id: "cursor",
  title: "Cursor",
  cli: { name: "cursor-agent", desktopApp: { title: "Cursor", mac: ["Cursor"], windows: ["Programs\\cursor"] } },
  install: "install Cursor's CLI ({install}) and sign in",
  setup: {
    install: [process.platform === "win32" ? { powershell: "https://cursor.com/install?win32=true" } : { script: "https://cursor.com/install" }],
    signIn: "cursor-agent login",
    docs: "https://cursor.com/docs/cli/overview"
  },
  picks: [{ key: "model", title: "Model", choices: [], freeText: true }],
  probe: { args: ["status"], says: (output) => cursorSignedIn(output), reason: "Cursor's CLI is not signed in — run `cursor-agent login`" },
  mcpLink: cursorMcpLink,
  // Last: every call carries Cursor's own tool definitions (about 15k tokens) and counts against its plan.
  lend: { rank: 80, ask: cursorAsk }
};
