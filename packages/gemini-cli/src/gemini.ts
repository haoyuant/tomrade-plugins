import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { GEMINI_SIGN_IN, geminiCanSignIn } from "./auth.js";
import { geminiAsk } from "./lend.js";

export const GeminiOptions = z.object({
  command: z.string().default("gemini"),
  /** A model as Gemini CLI lists it (`auto`, `gemini-2.5-pro`, …); empty keeps its own. */
  model: z.string().optional()
});
export type GeminiOptions = z.infer<typeof GeminiOptions>;

/** Gemini CLI ids a tool call `<tool>__<id>`, and its ACP updates name the call nowhere else. */
export function geminiCallName(toolCallId: string): string | undefined {
  const at = toolCallId.indexOf("__");
  return at > 0 ? toolCallId.slice(0, at) : undefined;
}

export const gemini: LocalAgentSpec<GeminiOptions> = {
  id: "gemini",
  title: "Gemini CLI",
  cli: { name: "gemini" },
  install: "install Gemini CLI ({install}) and sign in",
  // Google ended personal Google sign-in for it: individuals use an API key or Vertex AI.
  setup: { install: ["npm install -g @google/gemini-cli"], signIn: "gemini", signInRuns: true, docs: "https://github.com/google-gemini/gemini-cli" },
  options: GeminiOptions,
  acp: {
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
    // "default" asks before edits, commands and MCP tools, whatever mode the person set for it, and Tomrade answers for the turn.
    // Never switched later: a switch is announced as "[MODE_UPDATE] …" in the reply.
    args: () => ["--acp", "--approval-mode", "default"],
    // In a folder it does not trust it starts no MCP server, Tomrade's included; this one is Tomrade's own, or the ticket's checkout.
    env: () => ({ GEMINI_CLI_TRUST_WORKSPACE: "true" }),
    reopen: "never",
    callName: geminiCallName,
    // Code link hands it a ticket in a terminal with a session-only settings file.
    terminal: true,
    usage: "turn"
  },
  signIn: GEMINI_SIGN_IN,
  signedIn: { ask: () => geminiCanSignIn(), reason: `Gemini CLI cannot sign in with a personal Google account any more — ${GEMINI_SIGN_IN}` },
  // Gemini CLI answers one prompt headless, so its sign-in can do worker calls too.
  lend: { rank: 40, ask: geminiAsk }
};
