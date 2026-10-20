# Changelog

## 0.1.0

- DeepSeek Harness as a local agent, moved out of the Tomrade app: conversations and tickets over `dsh --profile acp` with Tomrade's tools and its reasoning efforts, the desktop app's own `dsh` found on macOS and Windows, a ticket handed to a headless run in a terminal, and `dsh --profile headless` answering Tomrade's background calls through a one-run patch. Settings and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
