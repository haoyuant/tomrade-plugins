# WeCom (企业微信)

Talk to a Tomrade project's assistant from WeCom through an intelligent bot (智能机器人): direct chats, and @mentions in groups. Questions and approvals come as template cards with buttons and choices; replies stream into the chat. Tomrade connects from this computer over the bot's long connection, so no public address, callback URL or trusted IP is needed. Nothing runs in the cloud: the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → 企业微信 WeCom. The wizard lists the steps: in the WeCom app, Workbench → Intelligent bots → Create bot → Create manually → Create in API mode, with the connection method **Use long connection**. Only the Bot ID and Secret are needed, and they are stored encrypted on this computer. A private deployment also fills in the long-connection address its admin console shows; the plugin's network permission names only WeCom's public hosts, so such a deployment needs its own build.

What the adapter does:

- Long connection: subscribes with the Bot ID and Secret, pings every thirty seconds (a ping nobody answers drops the socket) and reconnects with backoff. WeCom keeps one connection per bot; when another one takes the bot over, this one stops and says so instead of fighting for it.
- Groups: the bot only hears messages that @mention it, and the leading mention is dropped, so `@bot /status` runs `/status`. A reply goes on the asking message's callback, which WeCom shows against that message. A quoted message goes along as context; a quote of the bot's own reply is recognised and, while a turn runs, steers it.
- Replies within reach of a callback (24 hours) answer it; anything else (a direct chat, a reminder, an expired callback) is pushed to the chat.
- Streaming: a waiting message gets a "thinking" stream at once, which the reply then takes over and keeps refreshing (at most every three seconds) until it settles with the final text. WeCom ends a stream after ten minutes; a reply that runs longer arrives whole as a new message.
- Cards: buttons make a button card (six at most, more become a single-choice vote), each select a vote card, multi-select included. A press is answered inside WeCom's five seconds: the card shows the choice and takes no more, for whoever pressed it in a group. Free-text answers are typed as `/answer`. Labels too wide for a card are numbered there and spelled out above it; sections and links are Markdown, `tomrade://` links shown as text.
- Files both ways: incoming images and files (single chats, and images in a group's mixed message) are downloaded and decrypted as they arrive, since their addresses last five minutes. Outgoing images up to 10 MB go as images and other files up to 20 MB as files, uploaded in 512 KB chunks.
- Limits: WeCom allows 30 messages a minute and 1000 an hour per conversation, replies, pushes and stream refreshes alike. The adapter counts every frame, folds stream refreshes and leaves a reserve so a final answer or a card still fits; a delivery that would go over waits exactly as long as needed, and WeCom's own limit answer is retried with backoff. A message is never posted twice, and a redelivered message reaches the IM layer once.
- Commands are plain text (`/new`, `/stop`, `/status`, …); WeCom has no native command menu for bots.

`src/fake.ts` is an in-memory WeCom used by the tests and by `tomrade-plugin test` (`src/test.ts`).
