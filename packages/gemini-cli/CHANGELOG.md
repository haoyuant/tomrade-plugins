# Changelog

## 0.1.2

- Set up installs Gemini CLI in one click: Tomrade runs the npm install itself (the system's npm, or its own when there is none), then opens a terminal for the sign-in and watches it. Needs Tomrade with plugin SDK 0.2.26.

## 0.1.1

- The install guide links Gemini CLI's official installation page. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- Gemini CLI as a local agent, moved out of the Tomrade app: conversations and tickets over `gemini --acp` with Tomrade's tools, asking before it acts and answered by Tomrade for the turn, a ticket handed to `gemini` in a terminal, a sign-in check that knows Google ended personal Google sign-in for it, and `gemini -p` answering Tomrade's background calls bare, its sessions not kept. Settings and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
