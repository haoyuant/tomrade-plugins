# Changelog

## Unreleased

- DeepSeek Harness's ended terminal sessions show their conversation in the Terminal window's archive (what you asked, its answers, its tool calls and their results), read from the compressed session logs dsh keeps under `~/.dsh/sessions` and named by dsh's own title. Needs Tomrade with plugin SDK 0.2.29 (Tomrade 0.21).

## 0.1.2

- Set up installs the DeepSeek Harness CLI in one click: Tomrade runs the npm install itself (the system's npm, or its own when there is none), then opens a terminal for `dsh web` and watches it. Needs Tomrade with plugin SDK 0.2.26.

## 0.1.1

- The install guide links the official download page and says the DeepSeek Harness desktop app includes `dsh`, so installing the app is enough. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- DeepSeek Harness as a local agent, moved out of the Tomrade app: conversations and tickets over `dsh --profile acp` with Tomrade's tools and its reasoning efforts, the desktop app's own `dsh` found on macOS and Windows, a ticket handed to a headless run in a terminal, and `dsh --profile headless` answering Tomrade's background calls through a one-run patch. Settings and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
