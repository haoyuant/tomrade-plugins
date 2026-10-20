import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalAgentMcpLink, LocalAgentOptions } from "@tomradex/plugin-sdk";

export const MCP_NAME = "tomrade";

/** Where `agy mcp add` keeps servers: ~/.gemini/config/mcp_config.json, shared with the Antigravity app. */
export const agyMcpFile = (home = os.homedir()): string => path.join(home, ".gemini", "config", "mcp_config.json");

/** The address agy's `tomrade` server names; null when there is none. */
export function agyConfiguredUrl(file = agyMcpFile()): string | null {
  if (!fs.existsSync(file)) return null;
  const url = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { serverUrl?: unknown }> }).mcpServers?.[MCP_NAME]?.serverUrl;
  return typeof url === "string" ? url : null;
}

/** agy's own sessions reach Tomrade through a tokenless user-level `tomrade` server, changed with `agy mcp add|remove`. */
export const agyMcpLink: LocalAgentMcpLink<LocalAgentOptions> = {
  cli: {
    file: () => agyMcpFile(),
    configuredUrl: () => agyConfiguredUrl(),
    // "Add or update": an entry at an old address is replaced in place.
    add: (url) => ["mcp", "add", MCP_NAME, url],
    remove: () => ["mcp", "remove", MCP_NAME]
  }
};
