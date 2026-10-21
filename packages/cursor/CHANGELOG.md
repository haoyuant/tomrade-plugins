# Changelog

## 0.1.1

- The install guide links the official download page (cursor.com/download) and says the Cursor app does not include `cursor-agent`. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- Cursor's CLI as a local agent, moved out of the Tomrade app: a ticket handed to `cursor-agent` in a terminal, its availability read from `cursor-agent status` (and the Cursor app named when only it is installed), a typed-in Model, its own sessions connected through `~/.cursor/mcp.json`, and `cursor-agent -p` in ask mode answering Tomrade's background calls. Settings and the connection carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
