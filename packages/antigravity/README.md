# Antigravity CLI

[Antigravity CLI](https://antigravity.google/docs/cli) (`agy`), Google's successor to Gemini CLI, as a coding agent in Tomrade. Install it and run `agy` once to sign in; Tomrade finds the `agy` command (or the path set in Settings → Assistant → Antigravity CLI). When only the Antigravity desktop app is installed, Tomrade says so and points to the CLI's installer.

What it does:

- **In a terminal**, a ticket goes to `agy`, which reaches Tomrade through its own connection and claims the ticket first. agy has no ACP, so conversations in the app do not run on it; its Model (any name agy takes) and Effort (low to max) picks apply to the terminal.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → Antigravity CLI): Tomrade runs `agy mcp add tomrade <address>`, which keeps the server in `~/.gemini/config/mcp_config.json`, shared with the Antigravity app. Disconnecting runs `agy mcp remove tomrade`.
- **Background calls** (titles, triage, plans when no model is connected) can run on your agy in print mode, the prompt sent as stream-json from an empty folder. Headless, agy denies itself every command and MCP call, and each call's conversation is deleted from `~/.gemini/antigravity-cli` once it answers.

Settings and the connection carry over from the Antigravity CLI built into earlier Tomrade versions: the engine keeps the id `agy`.
