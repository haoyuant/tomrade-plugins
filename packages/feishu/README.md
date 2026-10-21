# Feishu / Lark

Talk to a Tomrade project's assistant from Feishu or Lark: direct chats, @mentions and replies in groups, and topics. Questions and approvals come as card buttons, selects and forms; replies stream into a card. Tomrade connects from this computer over Feishu's long connection; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → 飞书 Feishu (or Lark). The wizard lists the developer-console steps; only the App ID and App Secret are needed, and they are stored encrypted on this computer.

## Use it in a group

1. **Connect and pair** in Settings → IM, then send the bot the pairing code from Tomrade in a direct chat.
2. **Add the bot to the group:** the group's settings → **Bots** → **Add bot**, and pick the app. It must be published, with the group's members in its availability.
3. **Allow it.** @mention the bot in the group and choose **Work**, **Status** or **Chat**. A group hears nothing until it is allowed.
4. **Work.** Move a ticket to Doing or Verifying: in a work group it gets a card of its own, and the ticket's news goes into that card's topic.

When Feishu refuses a post because the bot left the group (230002), the app lacks a permission (99991672, with the scopes Feishu names and a link to the console's permission page) or the bot may not do it in that group (230027), the group, or your direct chat when the group cannot hear it, is told once, and Settings → IM shows it on the connection. Once a post works there again, it is cleared.

What the adapter does:

- Long connection: asks Feishu for a socket address, pings on the interval Feishu sets (a ping nobody answers drops the socket), reconnects with backoff through a fresh address, and joins events Feishu splits into parts. Every event is acknowledged; Feishu redelivers what was not, and the IM layer keeps each event once.
- Groups: a message that @mentions the bot, or replies to one of its messages, is answered with a quote reply; a message written in a topic is answered in that topic (`reply_in_thread`), and later messages there need no @ once the bot has answered.
- A topic per ticket being worked, in a group whose conversation has "A thread per ticket" on (the default): its first message is a card naming the ticket's key, status and title, and the ticket's news is replied into its thread. The card follows the ticket and shows ✅ once it is done (Feishu has no archive). Messages in the topic need no @ when `im:message.group_msg` is granted; without it, @mention the bot there. No topic opens in a direct chat: the chat's mode comes from its messages, or from the chat API (`im:chat:readonly`) when the bot has not seen it yet, and without that scope the IM layer's word that it is a group is taken. With the optional `im:message.group_msg` scope, other group messages reach the route's recent-discussion window.
- The quoted message and a topic's first message go along as context, with their authors' names when the contact scope is granted.
- Cards (JSON 2.0): Markdown, sections, buttons, web links; selects, multi-selects and text entries sit in forms with a submit button. Every callback is answered inside Feishu's three seconds and the outcome updates the card. `tomrade://` links are shown as text, since card buttons open web links only.
- Streaming through CardKit when `cardkit:card:write` is granted, settled with the final content; without it, a card that is edited as the reply grows.
- An "OnIt" reaction when a message is taken, swapped for "DONE" or a cross when its turn ends.
- Files both ways: images up to 10 MB go as images, other files up to 30 MB as files; incoming images and files are handed over with their real size.
- Commands are plain text (`/new`, `/stop`, `/status`, …); bot-menu entries that push an event run the command named by their key.
- Five messages a second per chat; a rate limit waits as long as Feishu says, a stale tenant token is renewed, and a message is never posted twice (Feishu's uuid deduplication).

`src/fake.ts` is an in-memory Feishu used by the tests and by `tomrade-plugin test` (`src/test.ts`).
