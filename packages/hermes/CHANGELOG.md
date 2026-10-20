# Changelog

## 0.1.0

- Hermes Agent as a local agent, moved out of the Tomrade app: conversations and tickets over `hermes acp` with Tomrade's tools, mid-turn messages as `/steer`, a ticket handed to `hermes chat` in a terminal, its own sessions connected through `~/.hermes/config.yaml` and a reporting plugin, and `hermes -z` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
