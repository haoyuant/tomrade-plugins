# Gemini CLI

Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli) as a coding agent in Tomrade. Install it (`npm install -g @google/gemini-cli`), run `gemini`, enter `/auth` and choose Use Gemini API Key (or Vertex AI): Google no longer lets individuals sign in with a personal Google account. Tomrade finds the `gemini` command (or the path set in Settings → Assistant → Gemini CLI).

What it does:

- **Conversations and tickets** run on `gemini --acp`, with Tomrade's tools handed to it as an MCP server in a folder it is told to trust. It asks before edits, commands and MCP tools, and Tomrade answers for the turn as the permission mode says: Full access, Ask permissions (each one goes to you) or Read only. Its model list is whatever it offers once a session opens.
- **In a terminal**, a ticket goes to `gemini` with a session-only settings file that reaches Tomrade.
- **Ended sessions** show their conversation in the Terminal window's archive: what you asked, Gemini's answers and its tool calls with what they returned, read (never written) from the session Gemini CLI saves under `~/.gemini/tmp/<project>/chats`, and named by the summary Gemini wrote for it, else by your first message. Gemini CLI reports no session id to Tomrade on its own, so this reaches the terminal sessions whose id Tomrade knows: those that carry on a conversation the ticket already had with Gemini CLI in Tomrade (`gemini -r`). A session Tomrade has no id for keeps showing only that it ended. Needs Tomrade with plugin SDK 0.2.29.
- **Signed out**: while its own settings choose a personal Google sign-in, or an API key that is not there, Tomrade says so and how to fix it instead of starting it.
- **Background calls** (titles, triage, plans when no model is connected) can run on your Gemini CLI as `gemini -p`, with its prompt swapped for the call's and no tools, MCP servers, extensions, skills or hooks. Without a model set here or in Gemini CLI, they ask Flash. The session it saves for each call is removed afterwards.

Settings and past sessions carry over from the Gemini CLI built into earlier Tomrade versions: the engine keeps the id `gemini`.
