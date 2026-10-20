# OpenCode

[OpenCode](https://opencode.ai) as a coding agent in Tomrade. Install OpenCode and run `opencode auth login` to add a provider and its key; Tomrade finds the `opencode` command (or the path set in Settings → Assistant → OpenCode).

What it does:

- **Conversations and tickets** run on `opencode acp`, with Tomrade's tools handed to it as an MCP server. Full access runs its "build" agent; Local rules keeps it to what OpenCode's own permission rules allow; Read only runs its "plan" agent, which cannot edit or run commands. Its model list comes from `opencode models` until a session opens, then from the session; Settings → Assistant → OpenCode can pin a `provider/model`.
- **In a terminal**, a ticket goes to `opencode` with its session.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → OpenCode): Tomrade adds a `tomrade` server to `~/.config/opencode/opencode.json` (under `$XDG_CONFIG_HOME` when set), naming each session's token as `{env:TOMRADE_MCP_TOKEN}`, and writes a small reporting plugin to `~/.config/opencode/plugins/tomrade.js`. Disconnecting takes both back out; the rest of opencode.json stays as it was, and a `tomrade.js` that is not Tomrade's is left alone.
- **Background calls** (titles, triage, plans when no model is connected) can run on your OpenCode as `opencode run`, as an agent of Tomrade's own with every tool denied and external plugins off.

Settings, the connection and past sessions carry over from the OpenCode built into earlier Tomrade versions: the engine keeps the id `opencode`.
