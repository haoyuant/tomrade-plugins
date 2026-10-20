# WorkBuddy

[WorkBuddy](https://www.workbuddy.ai) from Tencent as a coding agent in Tomrade, through its CodeBuddy Code CLI. Install the WorkBuddy app, or the CLI alone with `npm install -g @tencent-ai/codebuddy-code`, and sign in by running `codebuddy` and `/login` with your WorkBuddy account. Tomrade finds the `codebuddy` command (or the path set in Settings → Assistant → WorkBuddy); without one, it uses the copy inside the WorkBuddy app, run by the app's own runtime, so a machine with the app needs no Node.

What it does:

- **Conversations and tickets** run on `codebuddy --acp`, with Tomrade's tools handed to it as an MCP server. Full access lets it act without asking; Ask permissions and Read only send each tool's first use to Tomrade, which decides. A message sent while it works reaches it through `session/steer` (CodeBuddy 2.134 and later). Its model list comes from `codebuddy --help` until a session offers its own.
- **In a terminal**, a ticket goes to interactive `codebuddy`.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → WorkBuddy): Tomrade runs `codebuddy mcp add --scope user` to add a `tomrade` server to `~/.codebuddy/.mcp.json` (or `$CODEBUDDY_CONFIG_DIR`), and `codebuddy mcp remove --scope user` to take it out.
- **Background calls** (titles, triage, plans when no model is connected) can run on your signed-in CodeBuddy as `codebuddy -p`, with no tools, MCP servers, settings, memory or saved session, on the model set in Tomrade or else the one you last picked in CodeBuddy.
- **Troubleshooting** reads CodeBuddy's latest logs and tells Tencent's internal (iOA) edition apart by its models.

Settings, the connection and past sessions carry over from the WorkBuddy built into earlier Tomrade versions: the engine keeps the id `workbuddy`.
