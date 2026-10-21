# CodeBuddy (WorkBuddy)

[WorkBuddy](https://www.workbuddy.ai) from Tencent as a coding agent in Tomrade, through the CodeBuddy CLI (`codebuddy`). **The WorkBuddy desktop app does not install the CLI for you**: installing WorkBuddy alone is not enough. Install the CLI with `npm install -g @tencent-ai/codebuddy-code` (Node.js 18.20 or later; Homebrew and a native installer are in [CodeBuddy's installation guide](https://www.codebuddy.ai/docs/cli/installation)), then sign in by running `codebuddy` and typing `/login`. Tomrade finds the `codebuddy` command (or the path set in Settings → Assistant → CodeBuddy (WorkBuddy)). With only the WorkBuddy app on the machine, Tomrade shows the agent as not ready and says to install the CLI. The copy of the CLI inside the app serves only the app and gets no models when started on its own, so Tomrade does not use it.

What it does:

- **Conversations and tickets** run on `codebuddy --acp`, with Tomrade's tools handed to it as an MCP server. Full access lets it act without asking; Ask permissions and Read only send each tool's first use to Tomrade, which decides. A message sent while it works reaches it through `session/steer` (CodeBuddy 2.134 and later). Its model list comes from `codebuddy --help` until a session offers its own.
- **In a terminal**, a ticket goes to interactive `codebuddy`.
- **Its own sessions** reach Tomrade once you connect it (Settings → Assistant → CodeBuddy (WorkBuddy)): Tomrade runs `codebuddy mcp add --scope user` to add a `tomrade` server to `~/.codebuddy/.mcp.json` (or `$CODEBUDDY_CONFIG_DIR`), and `codebuddy mcp remove --scope user` to take it out.
- **Background calls** (titles, triage, plans when no model is connected) can run on your signed-in CodeBuddy as `codebuddy -p`, with no tools, MCP servers, settings, memory or saved session, on the model set in Tomrade or else the one you last picked in CodeBuddy.
- **Troubleshooting** reads CodeBuddy's latest logs and tells Tencent's internal (iOA) edition apart by its models.

Settings, the connection and past sessions carry over from the WorkBuddy built into earlier Tomrade versions: the engine keeps the id `workbuddy`.
