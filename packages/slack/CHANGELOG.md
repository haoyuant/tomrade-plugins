# Changelog

## 0.3.0

- A channel the bot was not invited to (`not_in_channel`, `channel_not_found`) or a scope the app lacks (`missing_scope`, named as Slack names it) is said once per channel, with the `/invite` to type or the scope to add (SDK 0.2.20 notices; your direct message hears it when the channel cannot), and cleared once a call works there again.
- Settings → IM shows Slack's own steps for using a channel (SDK 0.2.22 `groupSteps`); the README has the same steps and the scope each feature needs.

## 0.2.0

- A thread per ticket being worked in a channel (Tomrade's ticket topics, SDK 0.2.19): the bot posts a message naming the ticket and its status, and the ticket's news and conversation go into its thread. The message follows the ticket's status and is marked ✅ once the ticket is done; message metadata marks it, so the thread is still known after a restart. Follow-ups in the thread need no @.

## 0.1.0

- Slack IM over Socket Mode: direct messages and the agent view, @mentions and threads in channels, buttons, selects and text entries for questions, replies that stream into the thread, and Tomrade's commands through `/tomrade`.
