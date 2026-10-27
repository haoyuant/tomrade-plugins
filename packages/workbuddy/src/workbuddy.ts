import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentDesktopApp, type LocalAgentPick, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { codebuddyConfigDir, effectiveRegion, regionEnv } from "./config.js";
import { codebuddyAsk } from "./lend.js";
import { workbuddyMcpLink } from "./link.js";

export const WorkBuddyOptions = z.object({
  command: z.string().default("codebuddy"),
  /** A model id as CodeBuddy lists it (`default-model`, `hy3`, …); empty keeps the one it last used. */
  model: z.string().optional(),
  /** Its thought level: minimal, low, medium, high, xhigh or max. */
  effort: z.string().optional(),
  /**
   * Which CodeBuddy service the account belongs to. auto changes nothing:
   * whatever the CLI already uses (shell environment or its own settings)
   * stays in charge. The others are written into the CLI's settings and the
   * session's environment, so sign-in and every later run agree.
   */
  region: z.enum(["auto", "china", "international"]).default("auto")
});
export type WorkBuddyOptions = z.infer<typeof WorkBuddyOptions>;

/**
 * The WorkBuddy desktop app, named when it is installed but the CodeBuddy CLI
 * is not. The copy of the CLI inside the app serves only the app: started on
 * its own it gets no models, so Tomrade does not take it for the CLI.
 */
export const WORKBUDDY_APP: LocalAgentDesktopApp = {
  title: "WorkBuddy",
  mac: ["WorkBuddy", "WorkBuddy AI"],
  windows: ["Programs\\WorkBuddy", "Programs\\WorkBuddy AI", "Programs\\WorkBuddyAI", "Programs\\workbuddy-ai", "WorkBuddy", "WorkBuddy AI"]
};

/** CodeBuddy reports each model request's tokens, OpenAI-style, inside a usage update's `_meta`. */
export function codebuddyUsage(update: Record<string, any>): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  const usage = update._meta?.usage;
  if (!usage || typeof usage.prompt_tokens !== "number") return null;
  const cached = [usage.prompt_cache_hit_tokens, usage.prompt_tokens_details?.cached_tokens, usage.cache_read_input_tokens].filter((n): n is number => typeof n === "number");
  const written = [usage.prompt_cache_write_tokens, usage.cache_creation_input_tokens].filter((n): n is number => typeof n === "number");
  return {
    input: usage.prompt_tokens,
    output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    ...(cached.length ? { cacheRead: Math.max(...cached) } : {}),
    ...(written.length ? { cacheWrite: Math.max(...written) } : {})
  };
}

/**
 * CodeBuddy ends every failed turn with stopReason "refusal" and puts the
 * reason in `_meta["codebuddy.ai/errorMessage"]` — a JSON-RPC error whose
 * `data.details` holds the upstream words ("Internal error" alone says nothing).
 * Its status code and category stay in the details.
 */
export function codebuddyFailure(response: Record<string, any>): string | undefined {
  const raw = response._meta?.["codebuddy.ai/errorMessage"] ?? response.errorMessage ?? response._meta?.errorMessage;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return raw.trim(); }
  if (!parsed || typeof parsed !== "object") return raw.trim();
  const details = typeof parsed.data?.details === "string" && parsed.data.details.trim() ? parsed.data.details.trim() : undefined;
  const message = typeof parsed.message === "string" && parsed.message.trim() && parsed.message !== "Internal error" ? parsed.message.trim() : undefined;
  return message && details && !message.includes(details) ? `${message} — ${details}` : (message ?? details);
}

/** `codebuddy --help` lists the models it takes: "Currently supported: (a, b, c)". */
export function helpModels(help: string): string[] {
  const list = /Currently supported:\s*\(([^)]*)\)/.exec(help.replace(/\s+/g, " "))?.[1];
  return list ? list.split(",").map((model) => model.trim()).filter(Boolean) : [];
}

/** Newest first, at most a few: the files in `dir` that `keep` lets through. */
export function newestLogs(dir: string, keep: (name: string) => boolean, limit = 2): string[] {
  try {
    return fs.readdirSync(dir).filter(keep).map((name) => path.join(dir, name))
      .map((file) => ({ file, at: fs.statSync(file).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, limit).map((f) => f.file);
  } catch {
    return [];
  }
}

const SIGN_IN = "sign in to CodeBuddy: run `codebuddy` and type /login";

/** A machine-wide knob: the edition is the CLI's, not one conversation's. Empty is auto, the CLI's own default. */
const REGION_PICK: LocalAgentPick & { global: true } = {
  key: "region",
  title: "Version",
  global: true,
  choices: [
    { value: "china", label: "China edition" },
    { value: "international", label: "International" }
  ]
};

export const workbuddy: LocalAgentSpec<WorkBuddyOptions> = {
  id: "workbuddy",
  // It runs on the CodeBuddy CLI, which installing WorkBuddy does not give; the name says so.
  title: "CodeBuddy (WorkBuddy)",
  cli: { name: "codebuddy", desktopApp: WORKBUDDY_APP },
  install: "install the CodeBuddy CLI, which the WorkBuddy app does not include, with {install} (https://www.codebuddy.ai/docs/cli/installation), then run `codebuddy` and type /login",
  // Inside codebuddy, /login signs in.
  setup: { install: [{ npm: "@tencent-ai/codebuddy-code" }], signIn: "codebuddy", signInRuns: true, docs: "https://www.codebuddy.ai/docs/cli/installation", download: "https://www.codebuddy.ai/docs/cli/installation", desktop: { title: "WorkBuddy", shipsCli: false } },
  options: WorkBuddyOptions,
  picks: [REGION_PICK],
  acp: {
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask, PERMISSION_CHOICES["read-only"]] },
    args: () => ["--acp"],
    // Every few prompts CodeBuddy titles the session with the session's own model, thinking included, and
    // answers the prompt only once the title is back — 45 s after a 3 s reply on hy4-preview. Tomrade shows no such title.
    env: (opts) => ({ CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1", ...regionEnv(opts.region) }),
    // Interactive `codebuddy` takes Claude Code's flags and hooks, so a ticket can start in a terminal too.
    terminal: true,
    // "default" asks before the first use of every tool, so Tomrade decides what a read-only or ask turn lets through.
    mode: (policy) => (policy === "full-access" ? "bypassPermissions" : "default"),
    usage: codebuddyUsage,
    // `session/steer` (CodeBuddy 2.134+); an older CLI refuses the method and the message waits for the turn
    steer: "method",
    failure: codebuddyFailure
  },
  signIn: SIGN_IN,
  diagnostics: {
    // Each CLI process logs to <date>/<cwd hash>__<id>.log; the WorkBuddy app's own sessions are the desktop__ ones.
    logs: () => {
      const dir = path.join(codebuddyConfigDir(), "logs", new Date().toISOString().slice(0, 10));
      return newestLogs(dir, (name) => name.endsWith(".log") && !name.startsWith("desktop__"));
    },
    facts: (catalog) => {
      // Tencent's internal edition offers models named *-ioa and signs in against its own endpoint.
      const region = effectiveRegion();
      const edition = catalog.models.some((m) => /-ioa$/.test(m.value)) || region === "ioa" ? "ioa"
        : region === "internal" ? "china"
        : region === "public" || region === "external" ? (catalog.models.length ? "public" : "unknown")
        : region;
      return { edition, internetEnvironment: region };
    }
  },
  probe: {
    args: ["--help"],
    says: (output, catalog) => {
      const models = helpModels(output);
      if (models.length && !catalog.models.length) catalog.models = models.map((value) => ({ value }));
      return null;
    },
    reason: ""
  },
  mcpLink: workbuddyMcpLink,
  lend: { rank: 20, ask: codebuddyAsk(SIGN_IN) },
  // Claude Code's prompt: it opens on "1. Yes" (Enter takes it); Esc is "No, and tell CodeBuddy what to do differently"
  approval: { allow: ["enter"], deny: ["esc"] }
};
