# DeepSeek Harness

[DeepSeek Harness](https://www.deepseek.com/en/harness/) (`dsh`) as a coding agent in Tomrade. Install the DeepSeek Harness desktop app, or its CLI with `npm install -g @deepseek-ai/dsh`, and sign in or add a DeepSeek API key under Settings → Models there (or in `dsh web`), or set `DEEPSEEK_API_KEY`. Tomrade finds the `dsh` command on PATH, the launcher inside the desktop app when it is not on PATH (`/Applications` or `~/Applications` on macOS, its install folder on Windows), or the path set in Settings → Assistant → DeepSeek Harness.

What it does:

- **Conversations and tickets** run on `dsh --profile acp`, with Tomrade's tools handed to it as an MCP server. dsh's own sandbox rules decide what needs asking: Full access, or Local rules. Its reasoning effort (off, low, high, max) and model are picked per conversation; a model can name its provider as `provider/model`.
- **In a terminal**, a ticket goes to one headless dsh run, which code link shows and reports.
- **Background calls** (titles, triage, plans when no model is connected) can run on your dsh as `dsh --profile headless --json`, through a patch for that run alone: Tomrade's instructions as the whole system prompt, no tools, skills or project instructions, the model and effort you chose, and its session kept in a temporary folder that is removed afterwards.

Settings and past sessions carry over from the DeepSeek Harness built into earlier Tomrade versions: the engine keeps the id `dsh`.
