# Cursor

[Cursor's CLI](https://cursor.com/docs/cli/overview) (`cursor-agent`) as a coding agent in Tomrade. Install it with Cursor's installer and run `cursor-agent login`; Tomrade finds the `cursor-agent` command (or the path set in Settings → Assistant → Cursor). The Cursor desktop app alone does not bring the CLI, and Tomrade says so when it finds the app without it.

What it does:

- **Conversations and tickets** run on `cursor-agent acp`, with Tomrade's tools handed to it as an MCP server. Full access, Ask permissions and Read only are passed on to Cursor, which answers whatever it still asks for. The Model you type in Settings → Assistant → Cursor is passed as `--model`.
- **In a terminal**, a ticket goes to `cursor-agent`. Its sessions reach Tomrade through its own connection, `~/.cursor/mcp.json`, so the first act is claiming the ticket.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → Cursor): Tomrade adds a `tomrade` server to `~/.cursor/mcp.json`, which Cursor's editor and `cursor-agent` share, and keeps every other server there. The entry carries no token, so a session Tomrade starts claims its ticket first. Disconnecting takes it back out.
- **Background calls** (titles, triage, plans when no model is connected) can run on your Cursor sign-in as `cursor-agent -p` in ask mode, which reads but never edits or runs anything, from a folder of its own. It is tried last: every call carries Cursor's own tool definitions and counts against your Cursor plan.

Settings and the connection carry over from the Cursor built into earlier Tomrade versions: the engine keeps the id `cursor`.
