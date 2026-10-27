import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { opencodeAsk } from "./lend.js";
import { opencodeMcpLink } from "./link.js";
import { opencodeRecord } from "./record.js";

export const OpencodeOptions = z.object({
  command: z.string().default("opencode"),
  /** `provider/model` as OpenCode lists it; empty keeps its own default. */
  model: z.string().optional()
});
export type OpencodeOptions = z.infer<typeof OpencodeOptions>;

/** `opencode models` prints one `provider/model` per line; anything else (logs, warnings) is not a model. */
export const listedModels = (output: string): string[] => output.split("\n").map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));

export const opencode: LocalAgentSpec<OpencodeOptions> = {
  id: "opencode",
  title: "OpenCode",
  cli: { name: "opencode" },
  install: "install OpenCode ({install}) and add a provider",
  setup: {
    install: process.platform === "win32" ? [{ npm: "opencode-ai" }] : [{ script: "https://opencode.ai/install" }, { npm: "opencode-ai" }],
    signIn: "opencode auth login",
    signInRuns: true,
    docs: "https://opencode.ai/docs/",
    download: "https://opencode.ai/download",
    // Its desktop app leaves the CLI off PATH; on macOS only an action inside the app adds it.
    desktop: { title: "OpenCode", shipsCli: false }
  },
  options: OpencodeOptions,
  acp: {
    // Its "plan" agent cannot edit or run commands, so read-only is one it keeps; "build" asks only where its own rules say so.
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.local, PERMISSION_CHOICES["read-only"]] },
    args: () => ["acp"],
    mode: (policy) => (policy === "read-only" ? "plan" : "build"),
    // The prompt's answer counts that turn alone, its cached prompt tokens apart from inputTokens.
    usage: "turn",
    cacheApart: true,
    // `opencode` with a session id, as code link starts it.
    terminal: true
  },
  signIn: "run `opencode auth login` to add a provider and its key",
  diagnostics: {
    logs: () => [path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "opencode", "log", "opencode.log")]
  },
  // Fills the Model pick before any session has opened; a session's own list replaces it.
  probe: {
    args: ["models"],
    says: (output, catalog) => {
      const models = listedModels(output);
      if (models.length && !catalog.models.length) catalog.models = models.map((value) => ({ value }));
      return null;
    },
    reason: ""
  },
  mcpLink: opencodeMcpLink,
  // Its sessions in its own database, so an ended one in a terminal shows its conversation.
  record: opencodeRecord,
  // After Hermes: OpenCode starts its whole server for every call.
  lend: { rank: 70, ask: opencodeAsk }
};
