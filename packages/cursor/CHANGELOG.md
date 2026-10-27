# Changelog

## Unreleased

- A session waiting on Cursor's permission prompt in a terminal can be answered from Tomrade: Allow presses Enter on the "Run (once)" the prompt opens on, Deny presses Esc ("Skip & tell the agent what to do instead"). Shown by Tomrade with plugin SDK 0.2.30, only while the pane shows a prompt Tomrade recognises (Cursor's is from the Tomrade release after 0.22.0); an older Tomrade ignores it.
- Cursor's ended terminal sessions show their conversation in the Terminal window's archive (what you asked, its answers and its tool calls; Cursor's transcript keeps no tool output), read from the transcripts `cursor-agent` keeps under `~/.cursor/projects`. Needs Tomrade with plugin SDK 0.2.29 (Tomrade 0.21).

## 0.2.0

- Cursor runs inside Tomrade over ACP: conversations and tickets go to `cursor-agent acp`, which advertises HTTP MCP, with Tomrade's tools handed to it; Full access, Ask permissions and Read only are Cursor's own. The ticket in a terminal is still there.
- Background calls run in a folder only you can reach (`tomrade-cursor-worker-<your user id>` in the temporary directory, readable by you alone), no longer one every user on the computer shares. If that folder is not yours or is a link, a fresh private one is used, so another user cannot plant rules or an AGENTS.md that ride along.

## 0.1.2

- Set up signs in to Cursor without a terminal: Tomrade runs `cursor-agent login`, shows the sign-in link it prints, and finishes once `cursor-agent status` says signed in. Needs Tomrade with plugin SDK 0.2.26.

## 0.1.1

- The install guide links the official download page (cursor.com/download) and says the Cursor app does not include `cursor-agent`. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- Cursor's CLI as a local agent, moved out of the Tomrade app: a ticket handed to `cursor-agent` in a terminal, its availability read from `cursor-agent status` (and the Cursor app named when only it is installed), a typed-in Model, its own sessions connected through `~/.cursor/mcp.json`, and `cursor-agent -p` in ask mode answering Tomrade's background calls. Settings and the connection carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
