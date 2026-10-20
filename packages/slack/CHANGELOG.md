# Changelog

## 0.2.0

- A thread per ticket being worked in a channel (Tomrade's ticket topics, SDK 0.2.19): the bot posts a message naming the ticket and its status, and the ticket's news and conversation go into its thread. The message follows the ticket's status and is marked ✅ once the ticket is done; message metadata marks it, so the thread is still known after a restart. Follow-ups in the thread need no @.

## 0.1.0

- Slack IM over Socket Mode: direct messages and the agent view, @mentions and threads in channels, buttons, selects and text entries for questions, replies that stream into the thread, and Tomrade's commands through `/tomrade`.
