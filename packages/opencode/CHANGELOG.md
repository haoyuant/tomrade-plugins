# Changelog

## 0.1.1

- The install guide links the official download page (opencode.ai/download) and says the OpenCode desktop app does not put `opencode` on PATH. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- OpenCode as a local agent, moved out of the Tomrade app: conversations and tickets over `opencode acp` with Tomrade's tools (its "plan" agent for read-only turns), the models `opencode models` lists before a session opens, a ticket handed to `opencode` in a terminal, its own sessions connected through `~/.config/opencode/opencode.json` and a reporting plugin, and `opencode run` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
