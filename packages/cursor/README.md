# Cursor

[Cursor's CLI](https://cursor.com/docs/cli/overview) (`cursor-agent`) as a coding agent in Tomrade. Install it with Cursor's installer and run `cursor-agent login`; Tomrade finds the `cursor-agent` command (or the path set in Settings → Assistant → Cursor). The Cursor desktop app alone does not bring the CLI, and Tomrade says so when it finds the app without it.

What it does:

- **In a terminal**, a ticket goes to `cursor-agent`. Cursor has no ACP and no per-session MCP flag, so Tomrade does not run it inside the app: a conversation that picks Cursor is told to start the ticket "In a terminal". The Model you type in Settings is passed as `--model`.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → Cursor): Tomrade adds a `tomrade` server to `~/.cursor/mcp.json`, which Cursor's editor and `cursor-agent` share, and keeps every other server there. The entry carries no token, so a session Tomrade starts claims its ticket first. Disconnecting takes it back out.
- **Background calls** (titles, triage, plans when no model is connected) can run on your Cursor sign-in as `cursor-agent -p` in ask mode, which reads but never edits or runs anything, from a folder of its own. It is tried last: every call carries Cursor's own tool definitions and counts against your Cursor plan.

Settings and the connection carry over from the Cursor built into earlier Tomrade versions: the engine keeps the id `cursor`.
