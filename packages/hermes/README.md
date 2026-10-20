# Hermes

[Hermes Agent](https://hermes-agent.nousresearch.com) from Nous Research as a coding agent in Tomrade. Install Hermes and run `hermes setup` to choose its provider and model; Tomrade finds the `hermes` command (or the path set in Settings → Assistant → Hermes).

What it does:

- **Conversations and tickets** run on `hermes acp`, with Tomrade's tools handed to it as an MCP server. Full access lets Hermes act without asking; Ask permissions sends each edit to you. A message sent while it works reaches it as `/steer`. Its model list is whatever its provider offers once a session opens.
- **In a terminal**, a ticket goes to `hermes chat`, which reaches Tomrade through its own connection.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → Hermes): Tomrade adds a `tomrade` server to `~/.hermes/config.yaml` with `hermes config set`, naming each session's token as `${TOMRADE_MCP_TOKEN}`, and turns on a small reporting plugin in `~/.hermes/plugins/tomrade`. Disconnecting takes both back out. A folder of that name that is not Tomrade's is left alone.
- **Background calls** (titles, triage, plans when no model is connected) can run on your Hermes as `hermes -z`, with no tools but its todo list.

Settings, the connection and past sessions carry over from the Hermes built into earlier Tomrade versions: the engine keeps the id `hermes`.
