# Discord

Talk to a Tomrade project's assistant from Discord: direct messages, @mentions and replies in channels and threads. Questions and approvals come with buttons, selects and a form; `/tomrade <command>` runs the IM commands (`new`, `stop`, `status`, `steer`, `sessions`, …). Tomrade connects from this computer over the Discord Gateway; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → Discord. The wizard lists the Developer Portal steps; only the bot token is needed, and it is stored encrypted on this computer. Privileged intents stay off: a mention or a direct message carries its text without Message Content.

What the adapter does:

- Gateway with heartbeats; a dropped or silent connection resumes and Discord replays what was missed (the IM layer keeps each event once).
- Buttons, string selects (multi-select through `max_values`) and a modal for free text; every interaction is acknowledged within Discord's three seconds.
- Replies quote the message that asked (`message_reference`); messages inside a thread stay in it.
- A thread per ticket being worked, in a channel whose conversation has "A thread per ticket" on (the default): a public thread in a text channel, a post in a forum or media channel. Its name carries the ticket's key, status and title and follows the ticket; it is archived once the ticket is done and opened again if the ticket comes back. @mention the bot in the thread to talk about the ticket there. The bot needs **Create Public Threads**, **Send Messages in Threads** and **Manage Threads**.
- 👀 when a message is taken, ✅ or ❌ when its turn ends; typing while it works.
- Sections as embeds; `tomrade://` links are shown as text, since Discord link buttons take web links only.
- 2000-character messages, files up to 10 MB both ways, five messages a channel every five seconds; a 429 waits as long as Discord says, and a message is never posted twice (enforced nonce).

`src/fake.ts` is an in-memory Discord used by the tests and by `tomrade-plugin test` (`src/test.ts`).
