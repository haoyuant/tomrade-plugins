import { z } from "zod";
import { PERMISSION_CHOICES, type LocalAgentInstaller, type LocalAgentSpec } from "@tomradex/plugin-sdk";
import { agyAsk } from "./lend.js";
import { agyMcpLink } from "./link.js";
import { agyRecord } from "./record.js";

export const AgyOptions = z.object({
  /** The ACP server Google ships, as the ACP registry names it: `agy_acp_server.par` (`agy_acp_server.exe` on Windows). */
  command: z.string().default(process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"),
  /** A model as agy takes it; empty keeps its own. */
  model: z.string().optional(),
  /** low, medium, high, xhigh or max; empty keeps its own. */
  effort: z.string().optional()
});
export type AgyOptions = z.infer<typeof AgyOptions>;

/** The file inside the server's zip; the ACP registry lists it as `antigravity-acp`, from dl.google.com/agy-extensions. */
const SERVER = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
/** Google's CLI installer, for the terminal hand-off, `agy mcp add|remove` and print mode. */
const CLI_INSTALLER: LocalAgentInstaller = process.platform === "win32"
  ? { powershell: "https://antigravity.google/cli/install.ps1" }
  : { script: "https://antigravity.google/cli/install.sh" };

/**
 * The ACP server's zip for one machine, as Google publishes it; null where
 * Google publishes none (ia32, arm). The app downloads it and unpacks `file`
 * into a folder of its own that the engine's lookup reads, so a bare
 * `command` (`agy_acp_server.par`) keeps finding it.
 */
export function acpArchive(platform: string, arch: string): LocalAgentInstaller | null {
  type Os = "darwin" | "win32" | "linux";
  type Arch = "x64" | "arm64" | "ia32" | "arm";
  const zips: Record<string, { dir: string; name: string }> = {
    "darwin/arm64": { dir: "macos", name: "agy-acp-server-1.4.1-darwin-arm64.zip" },
    "darwin/x64": { dir: "macos", name: "agy-acp-server-1.4.1-darwin-x86_64.zip" },
    "linux/x64": { dir: "linux", name: "agy-acp-server-1.4.1-linux-x86_64.zip" },
    "linux/arm64": { dir: "linux", name: "agy-acp-server-1.4.1-linux-arm64.zip" },
    "win32/x64": { dir: "windows", name: "agy-acp-server-1.4.1-windows-x86_64.zip" },
    "win32/arm64": { dir: "windows", name: "agy-acp-server-1.4.1-windows-arm64.zip" }
  };
  const key = `${platform}/${arch}`;
  const zip = zips[key];
  if (!zip) return null;
  const url = `https://dl.google.com/agy-extensions/releases/${zip.dir}/${zip.name}`;
  return { archive: { url, file: SERVER, platform: { os: platform as Os, arch: arch as Arch } } };
}

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
  // A conversation starts the ACP server, not `agy`: that is the file "not found" is about, and `{install}` is its zip.
  install: `download ${SERVER} from Google's ACP releases ({install})`,
  setup: {
    // The server first, since it is what opens a conversation in the app; `agy` installs after it, for the terminal hand-off and `agy mcp add`.
    install: [...[acpArchive(process.platform, process.arch)].filter((step): step is LocalAgentInstaller => !!step), CLI_INSTALLER],
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
    // The ACP server Google ships from https://dl.google.com/agy-extensions/releases/ is started as it is, with no arguments (`--uid=` belongs to the registry's own sandbox).
    args: () => [],
    reopen: "load",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    // A ticket can also go to `agy` in a terminal, reaching Tomrade through `agy mcp add`.
    terminal: { via: "link" }
  },
  mcpLink: agyMcpLink,
  // Its transcripts under ~/.gemini/antigravity-cli/brain, so an ended session in a terminal shows its conversation.
  record: agyRecord,
  // Every call carries agy's own tool definitions (about 12k tokens).
  lend: { rank: 75, ask: agyAsk },
  // Its prompt ("Run this command?") opens on "1. Yes, run command" (Enter takes it); Esc cancels the call and asks what to do instead
  approval: { allow: ["enter"], deny: ["esc"] }
};
