# Slack

Talk to a Tomrade project's assistant from Slack: direct messages and the app's agent view, @mentions and threads in channels. Questions and approvals come as buttons, selects and text entries; replies stream into the thread. Tomrade connects from this computer over Socket Mode; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → Slack. The wizard has the app manifest to paste at api.slack.com/apps (Socket Mode, events, scopes, interactivity, the `/tomrade` command and the agent view) and the steps after it; only the App-Level Token (`xapp-…`, `connections:write`) and the Bot Token (`xoxb-…`) are needed, and they are stored encrypted on this computer. Socket Mode apps serve the workspace that made them and cannot be listed in the Slack Marketplace.

## Use it in channels

1. **Connect and pair.** Create the app from the manifest in Settings → IM → Connect a bot → Slack, paste its two tokens and save; then send the bot the pairing code from Tomrade in a direct message.
2. **Invite the bot.** In the channel, type `/invite @` and the bot's name. Slack lets a bot post only in channels it was invited to.
3. **Allow it.** @mention the bot in the channel and choose **Work**, **Status** or **Chat**. A channel hears nothing until it is allowed, and your direct messages never get ticket threads.
4. **Work.** Move a ticket to Doing or Verifying: in a work channel it gets a message of its own whose thread carries the ticket's news, rewritten as it moves and marked ✅ once it is done.

What each feature needs (all in the manifest):

| Feature | Scopes |
|---|---|
| @mentions, answers, a thread per ticket | `app_mentions:read`, `chat:write` |
| Direct messages and the agent view's status | `im:history`, `assistant:write` |
| 👀 / ✅ on your messages | `reactions:write` |
| Files both ways | `files:read`, `files:write` |
| People's names | `users:read` |
| `/tomrade` | `commands` |
| Follow-ups in a thread without @, and threads known after a restart | `channels:history`, `groups:history` (optional) |

When Slack refuses something because the bot is not in a channel (`not_in_channel`) or the app lacks a scope (`missing_scope`), it is said once, with the `/invite` to type or the scope to add, in the channel or, when the bot cannot post there, in your direct message; Settings → IM shows it on the connection. Once a call works there again, it is cleared.

What the adapter does:

- Socket Mode: asks `apps.connections.open` for an address, waits for `hello`, and acknowledges every envelope the moment it arrives, so buttons and commands are answered inside Slack's three seconds. A `disconnect` (or a socket that has been quiet for five minutes, which may have died in a sleep) brings up a fresh connection before the old one is let go; a drop reconnects with backoff. Slack redelivers what went unacknowledged; a redelivered event is passed on once.
- Direct messages: as in Slack's agent view, each message in the Messages tab starts its own conversation and is answered in its thread; a reply in the thread continues it. While a reply is on its way the thread shows the assistant status ("is thinking…"), and Slack's stop button runs `/stop`.
- Channels: a channel is one conversation. An @mention is answered in the thread of the message that asked, and with the `message.channels` / `message.groups` events a follow-up in a thread the bot has answered in needs no @. A mention inside someone else's thread hands the thread's first message to the assistant. Other channel messages reach the route's recent-discussion window when it is on.
- A thread per ticket being worked, in a channel whose conversation has "A thread per ticket" on: the bot posts a message naming the ticket (`TOM-42 · Doing · …`), and the ticket's card, status and pull request news go into its thread, which is the ticket's own conversation; follow-ups there need no @. The message is rewritten as the ticket moves and marked ✅ once it is done (Slack has no archive). It carries message metadata (`tomrade_topic`), so the thread is recognised after a restart when the app has the history scopes.
- Commands: Slack takes any message starting with `/` as a slash command, so Tomrade's commands go through `/tomrade`: `/tomrade status`, `/tomrade stop`, `/tomrade pair 123456`. Anything else after `/tomrade` is said to the assistant. In a direct message a command acts on the thread last written in. `@Tomrade /status` in a thread works too.
- Messages are Block Kit: the reply as mrkdwn, ticket cards as sections with fields, web links as buttons (`tomrade://` links as text), action buttons, a single select that answers when chosen, and multi-selects and text entries as input blocks with a submit button. A settled question is rewritten without its controls.
- Streaming with `chat.startStream` / `appendStream` / `stopStream` in the thread under the message that asked (Slack streams into threads only), then rewritten as mrkdwn with any controls. At the top of a direct message, or where Slack will not stream, the reply grows by edits instead.
- An 👀 reaction when a message is taken, swapped for ✅ or ❌ when its turn ends. A message deleted while it waits never runs; an edit is passed on, and never reruns one.
- Files both ways: incoming files are downloaded with the bot token; outgoing ones go through `files.getUploadURLExternal` and `files.completeUploadExternal` into the same thread, up to 30 MB; larger ones become a pointer to the Tomrade conversation.
- Three messages per three seconds per conversation; a 429 waits as long as `Retry-After` says. Slack has no idempotency key for posting, so a post whose answer was lost is reported uncertain rather than sent twice.

`src/fake.ts` is an in-memory Slack used by the tests and by `tomrade-plugin test` (`src/test.ts`).
