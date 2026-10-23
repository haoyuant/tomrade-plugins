import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { cursorAsk } from "./lend.js";
import { cursorMcpLink } from "./link.js";

export const CursorOptions = z.object({
  command: z.string().default("cursor-agent"),
  /** A model as Cursor names it; empty keeps its own default. */
  model: z.string().optional()
});
export type CursorOptions = z.infer<typeof CursorOptions>;

/** `cursor-agent status` prints "✓ Logged in as …" or "Not logged in". */
export function cursorSignedIn(output: string): boolean | null {
  if (/not logged in/i.test(output)) return false;
  return /logged in/i.test(output) ? true : null;
}

/**
 * Cursor's CLI (`cursor-agent`). Its `cursor-agent acp` server speaks ACP and
 * advertises HTTP MCP, which Tomrade hands it as `tomrade`; a ticket can also
 * be handed to it in a terminal, where its user-level `tomrade` server
 * (tokenless) reaches Tomrade and its first act is claim_ticket.
 */
export const cursor: LocalAgentSpec<CursorOptions> = {
  id: "cursor",
  title: "Cursor",
  cli: { name: "cursor-agent", desktopApp: { title: "Cursor", mac: ["Cursor"], windows: ["Programs\\cursor"] } },
  install: "install Cursor's CLI ({install}) and sign in",
  setup: {
    install: [process.platform === "win32" ? { powershell: "https://cursor.com/install?win32=true" } : { script: "https://cursor.com/install" }],
    signIn: "cursor-agent login",
    docs: "https://cursor.com/docs/cli/overview"
  },
  options: CursorOptions,
  acp: {
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
    args: () => ["acp"],
    // A ticket can also go to `cursor-agent` in a terminal, reaching Tomrade through ~/.cursor/mcp.json.
    terminal: { via: "link" }
  },
  picks: [{ key: "model", title: "Model", choices: [], freeText: true }],
  probe: { args: ["status"], says: (output) => cursorSignedIn(output), reason: "Cursor's CLI is not signed in — run `cursor-agent login`" },
  mcpLink: cursorMcpLink,
  // Last: every call carries Cursor's own tool definitions (about 15k tokens) and counts against its plan.
  lend: { rank: 80, ask: cursorAsk }
};
