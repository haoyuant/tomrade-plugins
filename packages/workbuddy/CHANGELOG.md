# Changelog

## 0.1.0

- WorkBuddy as a local agent, moved out of the Tomrade app: conversations and tickets over `codebuddy --acp` with Tomrade's tools (also the CLI inside the WorkBuddy app, on macOS and Windows), mid-turn messages through `session/steer`, a ticket handed to `codebuddy` in a terminal, its own sessions connected with `codebuddy mcp add --scope user`, and `codebuddy -p` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
