# Telegram

Talk to a Tomrade project's assistant from Telegram: direct chats, @mentions, replies and commands in groups, and forum topics. Questions and choices come as buttons; replies grow as drafts in a direct chat. Tomrade polls the Bot API from this computer; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → Telegram. The wizard walks through @BotFather; only the bot token is needed, and it is stored encrypted on this computer. The plugin's only network permission is `api.telegram.org`.

## Use it in a group

1. **Connect and pair.** In Settings → IM → Connect a bot → Telegram, paste the token from @BotFather and save; then send the bot the pairing code from Tomrade in a direct chat.
2. **Add the bot to your group.** The connection shows **Add the bot to a group**: pick the group, and Telegram asks to make the bot an admin with **Manage Topics**.
3. **Turn on Topics** in the group's settings, for a topic per ticket. Without them the group still works, with each ticket's news as a line in the group.
4. **Allow it.** @mention the bot in the group and choose **Work**, **Status** or **Chat**. A group hears nothing until it is allowed, and your direct chat never gets ticket topics.
5. **Work.** Move a ticket to Doing or Verifying: in a work group with Topics, it gets a topic of its own, named with its status and closed once it is done.

What each feature needs:

| Feature | Needs |
|---|---|
| Answering @mentions, replies and commands in a group | Nothing: privacy mode (the default) lets the bot see exactly those |
| A group's recent discussion for the assistant | Privacy mode off (`/setprivacy` → Disable at @BotFather, then add the bot to the group again) |
| A topic per ticket | A supergroup with **Topics** on, and the bot an admin with **Manage Topics** |

When a topic cannot be opened because the group has no Topics or the bot lacks Manage Topics, the group hears it once, with what to change and the link, and Settings → IM shows it on the connection. Once topics work there again, it is cleared.

What the adapter does:

- Long polling (`getUpdates`): the offset moves past an update only once the IM layer has stored it, so what arrives while Tomrade is closed (Telegram keeps it 24 hours) is fetched when it opens, and nothing is fetched twice. Event ids come from the message, not the update, so a message Telegram hands over again is still kept once. A dropped connection is retried with backoff; a bot whose updates go to a webhook fails to connect with a clear error, and the webhook is left alone.
- Groups: a message that @mentions the bot, replies to one of its messages, or is a command (`/status@your_bot`, or plain `/status`) is answered with a quote reply; a command meant for another bot is ignored. With privacy mode off, other messages reach the route's recent-discussion window. In a forum, a topic is a conversation of its own and replies stay in it (`message_thread_id`); the topic's name goes along as context, as does a quoted message.
- A forum topic per ticket being worked, in a supergroup with **Topics** on whose conversation has "A thread per ticket" on (the default): `createForumTopic` names it with the ticket's key, status and title (clipped to Telegram's 128 characters), `editForumTopic` follows the ticket, and `closeForumTopic` closes it once the ticket is done (`reopenForumTopic` if it comes back). Only a change is sent; after a restart Telegram's `TOPIC_NOT_MODIFIED` counts as done. The bot must be an **admin with the right to manage topics**; in a group without Topics, Telegram refuses and the ticket's news stays in the group. @mention the bot in the topic to talk about the ticket there.
- Buttons answer through `callback_query` and are acknowledged before anything else. `callback_data` carries the IM layer's token in 33 bytes. A select is a button per option; a multi-select ticks options in place and sends them with a submit button; a written answer is a ✍️ button that posts a reply prompt (ForceReply), and a reply to the prompt or to the card itself is the answer. Ticks and written answers are read from the card's own keyboard after a restart.
- Cards: sections in bold with their fields, web links as link buttons, `tomrade://` links as text (Telegram opens only web links). Text is Telegram HTML, cut at 4096 characters by the IM layer; if Telegram cannot parse it, the same words go as plain text. An edit that changes nothing counts as done; an edit without controls takes the old buttons away.
- Streaming: in a direct chat with `sendMessageDraft`, settled by sending the final message; in a group, one message edited as the reply grows. If drafts are refused, edits take over.
- 👀 when a message is taken, swapped for 👍 or 😢 when its turn ends; "typing" while it runs.
- Files both ways: images up to 10 MB go as photos, other files (and photos Telegram refuses) as documents; incoming photos, files, video and voice are handed over with their size. Telegram lets a bot fetch 20 MB, so larger files are named in the text, and outgoing files above 20 MB become a link.
- Commands are registered with `setMyCommands`; Telegram's Start button shows `/help`.
- About a message a second per chat, and 20 a minute in a group, paced before Telegram has to refuse; a rate limit waits as long as Telegram says. A new message whose answer was lost is reported uncertain, never sent twice blindly; a part already posted is not posted again on retry.

`src/fake.ts` is an in-memory Bot API used by the tests and by `tomrade-plugin test` (`src/test.ts`).
