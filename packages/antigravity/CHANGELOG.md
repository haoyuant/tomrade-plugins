# Changelog

## Unreleased

- agy's ended terminal sessions show their conversation in the Terminal window's archive (what you asked, its answers, its tool calls and their results), read from the transcript agy keeps for each conversation under `~/.gemini/antigravity-cli/brain`. Only sessions whose id Tomrade knows: those that carry on a conversation the ticket had with agy in Tomrade. Needs Tomrade with plugin SDK 0.2.29 (Tomrade 0.21).
- A session waiting on agy's permission prompt in a terminal can be answered from Tomrade: Allow presses Enter on the "Yes, run command" the prompt opens on, Deny presses Esc, which cancels the call and asks what to do instead. Shown by Tomrade with plugin SDK 0.2.30; an older Tomrade ignores it.

## 0.2.0

- Set up installs Google's ACP server too, `agy_acp_server.par` (`agy_acp_server.exe` on Windows), so a conversation opens in Tomrade after setup with no manual download: Tomrade downloads the zip from Google's ACP releases and unpacks it, then runs Antigravity's own installer for `agy`. Needs Tomrade with plugin SDK 0.2.27, which downloads and unpacks it.
- Antigravity runs inside Tomrade over ACP: conversations and tickets go to Google's `agy_acp_server.par` (`agy_acp_server.exe` on Windows), which advertises HTTP MCP, with Tomrade's tools handed to it and Effort from low to max. The ticket in a terminal is still there, as are `agy mcp add|remove` and print mode for background calls.

## 0.1.1

- The install guide links the official download page (antigravity.google/download) and says the Antigravity IDE does not include `agy`. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- Antigravity CLI as a local agent, moved out of the Tomrade app: a ticket handed to `agy` in a terminal with its Model and Effort picks, its own sessions connected through `agy mcp add|remove`, and agy in print mode answering Tomrade's background calls, each call's conversation forgotten. Settings and connection carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
