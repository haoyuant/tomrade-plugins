# Telegram

Talk to a Tomrade project's assistant from Telegram: direct chats, @mentions, replies and commands in groups, and forum topics. Questions and choices come as buttons; replies grow as drafts in a direct chat. Tomrade polls the Bot API from this computer; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → Telegram. The wizard walks through @BotFather; only the bot token is needed, and it is stored encrypted on this computer. The plugin's only network permission is `api.telegram.org`.

What the adapter does:

- Long polling (`getUpdates`): the offset moves past an update only once the IM layer has stored it, so what arrives while Tomrade is closed (Telegram keeps it 24 hours) is fetched when it opens, and nothing is fetched twice. Event ids come from the message, not the update, so a message Telegram hands over again is still kept once. A dropped connection is retried with backoff; a bot whose updates go to a webhook fails to connect with a clear error, and the webhook is left alone.
- Groups: a message that @mentions the bot, replies to one of its messages, or is a command (`/status@your_bot`, or plain `/status`) is answered with a quote reply; a command meant for another bot is ignored. With privacy mode off, other messages reach the route's recent-discussion window. In a forum, a topic is a conversation of its own and replies stay in it (`message_thread_id`); the topic's name goes along as context, as does a quoted message.
- Buttons answer through `callback_query` and are acknowledged before anything else. `callback_data` carries the IM layer's token in 33 bytes. A select is a button per option; a multi-select ticks options in place and sends them with a submit button; a written answer is a ✍️ button that posts a reply prompt (ForceReply), and a reply to the prompt or to the card itself is the answer. Ticks and written answers are read from the card's own keyboard after a restart.
- Cards: sections in bold with their fields, web links as link buttons, `tomrade://` links as text (Telegram opens only web links). Text is Telegram HTML, cut at 4096 characters by the IM layer; if Telegram cannot parse it, the same words go as plain text. An edit that changes nothing counts as done; an edit without controls takes the old buttons away.
- Streaming: in a direct chat with `sendMessageDraft`, settled by sending the final message; in a group, one message edited as the reply grows. If drafts are refused, edits take over.
- 👀 when a message is taken, swapped for 👍 or 😢 when its turn ends; "typing" while it runs.
- Files both ways: images up to 10 MB go as photos, other files (and photos Telegram refuses) as documents; incoming photos, files, video and voice are handed over with their size. Telegram lets a bot fetch 20 MB, so larger files are named in the text, and outgoing files above 20 MB become a link.
- Commands are registered with `setMyCommands`; Telegram's Start button shows `/help`.
- About a message a second per chat, and 20 a minute in a group, paced before Telegram has to refuse; a rate limit waits as long as Telegram says. A new message whose answer was lost is reported uncertain, never sent twice blindly; a part already posted is not posted again on retry.

`src/fake.ts` is an in-memory Bot API used by the tests and by `tomrade-plugin test` (`src/test.ts`).
