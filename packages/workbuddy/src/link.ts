import fs from "node:fs";
import path from "node:path";
import type { LocalAgentMcpLink } from "@tomradex/plugin-sdk";
import { codebuddyConfigDir } from "./config.js";
import type { WorkBuddyOptions } from "./workbuddy.js";

export const MCP_NAME = "tomrade";

/** CodeBuddy keeps user-scope servers in `.mcp.json` inside CODEBUDDY_CONFIG_DIR, else `~/.codebuddy`. */
export function codebuddyUserFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(codebuddyConfigDir(env), ".mcp.json");
}

/** WorkBuddy's own sessions reach Tomrade through a user-scope `tomrade` server, changed with `codebuddy mcp add|remove`. */
export const workbuddyMcpLink: LocalAgentMcpLink<WorkBuddyOptions> = {
  cli: {
    file: () => codebuddyUserFile(),
    configuredUrl: () => {
      const file = codebuddyUserFile();
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { url?: unknown }> } | null;
      const url = parsed?.mcpServers?.[MCP_NAME]?.url;
      return typeof url === "string" ? url : null;
    },
    add: (url) => ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, url],
    remove: () => ["mcp", "remove", "--scope", "user", MCP_NAME]
  }
};
