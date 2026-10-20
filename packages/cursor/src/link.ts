import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalAgentIo, LocalAgentMcpLink, LocalAgentOptions, McpLinkState } from "@tomradex/plugin-sdk";

/** Cursor's user-level servers, shared by the editor and cursor-agent. */
export const cursorMcpFile = (home = os.homedir()): string => path.join(home, ".cursor", "mcp.json");

/** The address of the `tomrade` server a config names; null when there is none; throws on a file that is not JSON. */
export function configuredMcpUrl(text: string): string | null {
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, { url?: unknown }> } | null;
  const url = parsed?.mcpServers?.tomrade?.url;
  return typeof url === "string" ? url : null;
}

/** A config with Tomrade's server set, or taken out; every other key as it was. */
export function withMcpEntry(text: string, url: string | null): string {
  const config = (text.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("expected a JSON object");
  const { tomrade: _, ...others } = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const mcpServers = url ? { ...others, tomrade: { url } } : others;
  const { mcpServers: __, ...rest } = config;
  return JSON.stringify(Object.keys(mcpServers).length ? { ...rest, mcpServers } : rest, null, 2) + "\n";
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

function view(io: LocalAgentIo<LocalAgentOptions>, error?: string): McpLinkState {
  const url = io.mcp.url;
  const file = cursorMcpFile();
  const manual = { connect: `add "tomrade": { "url": "${url ?? "<url>"}" } under mcpServers in ${file}`, disconnect: `edit ${file} and remove mcpServers.tomrade` };
  let configuredUrl: string | null = null;
  try {
    configuredUrl = configuredMcpUrl(read(file) || "{}");
  } catch (cause) {
    return { state: "unavailable", url, configuredUrl, file, manual, error: error ?? `Cannot read ${file}: ${message(cause)}` };
  }
  const state = !url ? "unavailable" : configuredUrl === url ? "connected" : configuredUrl ? "stale" : "missing";
  return { state, url, configuredUrl, file, manual, ...(error ? { error } : {}) };
}

function attempt(io: LocalAgentIo<LocalAgentOptions>, change: () => void): McpLinkState {
  try {
    change();
    return view(io);
  } catch (cause) {
    return view(io, message(cause));
  }
}

/**
 * Cursor's own sessions reach Tomrade through `~/.cursor/mcp.json`, written
 * here: cursor-agent can list and approve servers but not add one. The entry
 * carries no token, so a session Tomrade starts claims its ticket first.
 */
export const cursorMcpLink: LocalAgentMcpLink<LocalAgentOptions> = {
  status: (io) => view(io),
  connect(io) {
    const url = io.mcp.url;
    if (!url) return view(io, "Tomrade's MCP server is not running");
    return attempt(io, () => {
      const file = cursorMcpFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, withMcpEntry(read(file), url));
    });
  },
  disconnect(io) {
    return attempt(io, () => {
      const file = cursorMcpFile();
      if (fs.existsSync(file)) fs.writeFileSync(file, withMcpEntry(read(file), null));
    });
  }
};
