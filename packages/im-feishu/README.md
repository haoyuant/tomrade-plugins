# Feishu / Lark

Talk to a Tomrade project's assistant from Feishu or Lark: direct chats, @mentions and replies in groups, and topics. Questions and approvals come as card buttons, selects and forms; replies stream into a card. Tomrade connects from this computer over Feishu's long connection; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → 飞书 Feishu (or Lark). The wizard lists the developer-console steps; only the App ID and App Secret are needed, and they are stored encrypted on this computer.

What the adapter does:

- Long connection: asks Feishu for a socket address, pings on the interval Feishu sets (a ping nobody answers drops the socket), reconnects with backoff through a fresh address, and joins events Feishu splits into parts. Every event is acknowledged; Feishu redelivers what was not, and the IM layer keeps each event once.
- Groups: a message that @mentions the bot, or replies to one of its messages, is answered with a quote reply; a message written in a topic is answered in that topic (`reply_in_thread`), and later messages there need no @ once the bot has answered. With the optional `im:message.group_msg` scope, other group messages reach the route's recent-discussion window.
- The quoted message and a topic's first message go along as context, with their authors' names when the contact scope is granted.
- Cards (JSON 2.0): Markdown, sections, buttons, web links; selects, multi-selects and text entries sit in forms with a submit button. Every callback is answered inside Feishu's three seconds and the outcome updates the card. `tomrade://` links are shown as text, since card buttons open web links only.
- Streaming through CardKit when `cardkit:card:write` is granted, settled with the final content; without it, a card that is edited as the reply grows.
- An "OnIt" reaction when a message is taken, swapped for "DONE" or a cross when its turn ends.
- Files both ways: images up to 10 MB go as images, other files up to 30 MB as files; incoming images and files are handed over with their real size.
- Commands are plain text (`/new`, `/stop`, `/status`, …); bot-menu entries that push an event run the command named by their key.
- Five messages a second per chat; a rate limit waits as long as Feishu says, a stale tenant token is renewed, and a message is never posted twice (Feishu's uuid deduplication).

`src/fake.ts` is an in-memory Feishu used by the tests and by `tomrade-plugin test` (`src/test.ts`).
