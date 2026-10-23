# Changelog

## 0.1.2

- A background call too long for this computer's command line (Windows: 32,767 characters for the whole line; Linux: 128 KiB per argument; macOS: 1 MiB in all) is refused before Hermes starts, in the app's language, instead of failing to start it.

## 0.1.1

- The install guide links Hermes Agent's official installation page. Shown by Tomrade with plugin SDK 0.2.25; an older Tomrade ignores it.

## 0.1.0

- Hermes Agent as a local agent, moved out of the Tomrade app: conversations and tickets over `hermes acp` with Tomrade's tools, mid-turn messages as `/steer`, a ticket handed to `hermes chat` in a terminal, its own sessions connected through `~/.hermes/config.yaml` and a reporting plugin, and `hermes -z` answering Tomrade's background calls. Settings, connection and sessions carry over from the built-in. Needs Tomrade with plugin SDK 0.2.18.
