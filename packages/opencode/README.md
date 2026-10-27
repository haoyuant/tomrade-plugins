# OpenCode

[OpenCode](https://opencode.ai) as a coding agent in Tomrade. Install OpenCode and run `opencode auth login` to add a provider and its key; Tomrade finds the `opencode` command (or the path set in Settings → Assistant → OpenCode).

What it does:

- **Conversations and tickets** run on `opencode acp`, with Tomrade's tools handed to it as an MCP server. Full access runs its "build" agent; Local rules keeps it to what OpenCode's own permission rules allow; Read only runs its "plan" agent, which cannot edit or run commands. Its model list comes from `opencode models` until a session opens, then from the session; Settings → Assistant → OpenCode can pin a `provider/model`.
- **In a terminal**, a ticket goes to `opencode` with its session.
- **Ended sessions** show their conversation in the Terminal window's archive: what you asked, OpenCode's answers and its tool calls with their output, read (never written) from OpenCode's own database (`~/.local/share/opencode/opencode.db`, under `$XDG_DATA_HOME` when set, or the one `OPENCODE_DB` names), and named by the title OpenCode gave the session. The session's id comes from the reporting plugin below, so connect OpenCode (or the repository) for this. OpenCode before its SQLite database (its older `storage/` folder of JSON files) is not read. Needs Tomrade with plugin SDK 0.2.29, on a runtime with Node's SQLite (Tomrade 0.21 has it).
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → OpenCode): Tomrade adds a `tomrade` server to `~/.config/opencode/opencode.json` (under `$XDG_CONFIG_HOME` when set), naming each session's token as `{env:TOMRADE_MCP_TOKEN}`, and writes a small reporting plugin to `~/.config/opencode/plugins/tomrade.js`. Disconnecting takes both back out; the rest of opencode.json stays as it was, and a `tomrade.js` that is not Tomrade's is left alone.
- **Background calls** (titles, triage, plans when no model is connected) can run on your OpenCode as `opencode run`, as an agent of Tomrade's own with every tool denied and external plugins off.

Settings, the connection and past sessions carry over from the OpenCode built into earlier Tomrade versions: the engine keeps the id `opencode`.
