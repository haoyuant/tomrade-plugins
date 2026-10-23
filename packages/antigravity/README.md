# Antigravity CLI

[Antigravity CLI](https://antigravity.google/docs/cli) (`agy`), Google's successor to Gemini CLI, as a coding agent in Tomrade. Install it and run `agy` once to sign in; Tomrade finds the `agy` command (or the path set in Settings → Assistant → Antigravity CLI). When only the Antigravity desktop app is installed, Tomrade says so and points to the CLI's installer.

What it does:

- **Conversations and tickets** run on Google's ACP server for Antigravity, `agy_acp_server.par` (`agy_acp_server.exe` on Windows), the server the ACP registry lists for it. It is a separate download from the CLI — Google's [ACP releases](https://dl.google.com/agy-extensions/releases/) — and `agy` has no `acp` subcommand of its own. Tomrade finds `agy_acp_server.par` on its PATH (or starts the path set in Settings → Assistant → Antigravity CLI) and hands it Tomrade's tools over HTTP MCP, which it advertises. Model and Effort (low to max) come from its sessions, or from Settings. Full access and Ask permissions are passed on to it; non-dangerous commands run without asking either way, so it cannot promise a read-only turn.
- **In a terminal**, a ticket goes to `agy`, which reaches Tomrade through its own connection and claims the ticket first.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → Antigravity CLI): Tomrade runs `agy mcp add tomrade <address>`, which keeps the server in `~/.gemini/config/mcp_config.json`, shared with the Antigravity app. Disconnecting runs `agy mcp remove tomrade`.
- **Background calls** (titles, triage, plans when no model is connected) can run on your agy in print mode, the prompt sent as stream-json from an empty folder. Headless, agy denies itself every command and MCP call, and each call's conversation is deleted from `~/.gemini/antigravity-cli` once it answers.

Settings and the connection carry over from the Antigravity CLI built into earlier Tomrade versions: the engine keeps the id `agy`.
