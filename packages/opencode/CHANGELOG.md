# Changelog

## Unreleased

- OpenCode's ended terminal sessions show their conversation in the Terminal window's archive (what you asked, its answers, its tool calls and their output), read from OpenCode's own SQLite database and named by its own title. Needs Tomrade with plugin SDK 0.2.29 (Tomrade 0.21).

## 0.1.2

- Set up installs OpenCode in one click on Windows too: the npm install is one Tomrade runs itself (the system's npm, or its own when there is none), after OpenCode's own installer elsewhere. Needs Tomrade with plugin SDK 0.2.26.

## 0.1.1

- The install guide links the official download page (opencode.ai/download) and says the OpenCode desktop app does not put `opencode` on PATH. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- OpenCode as a local agent, moved out of the Tomrade app: conversations and tickets over `opencode acp` with Tomrade's tools (its "plan" agent for read-only turns), the models `opencode models` lists before a session opens, a ticket handed to `opencode` in a terminal, its own sessions connected through `~/.config/opencode/opencode.json` and a reporting plugin, and `opencode run` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
