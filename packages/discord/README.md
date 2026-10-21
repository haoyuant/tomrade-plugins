# Discord

Talk to a Tomrade project's assistant from Discord: direct messages, @mentions and replies in channels and threads. Questions and approvals come with buttons, selects and a form; `/tomrade <command>` runs the IM commands (`new`, `stop`, `status`, `steer`, `sessions`, …). Tomrade connects from this computer over the Discord Gateway; nothing runs in the cloud, so the bot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → Discord. The wizard lists the Developer Portal steps; only the bot token is needed, and it is stored encrypted on this computer. Privileged intents stay off: a mention or a direct message carries its text without Message Content. Once connected, the connection shows **Add the bot to a server**: a link that adds the bot with exactly the permissions it needs (View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Embed Links, Attach Files, Add Reactions, and optionally Manage Channels for `/tomrade setup`) and the `/tomrade` command. Open it again to re-authorize a bot added before it needed a permission.

## Use it in a server

1. **Connect.** In Settings → IM → Connect a bot → Discord, paste the bot token from the Developer Portal (create an application, then **Bot → Reset Token**) and save. That is all the portal needs.
2. **Add the bot to your server.** The connection now shows **Add the bot to a server**: open it, pick the server, authorize. It asks for exactly the permissions below.
3. **Pair.** Make a pairing code in Settings → IM and send it to the bot in a direct message; confirm on the desktop. Until then the bot answers no one.
4. **Set up the channels.** In the server, run **`/tomrade setup`** (add `project:` when you have several). It creates a **Tomrade** category with `#tomrade-work`, `#tomrade-status` and `#tomrade-chat` and allows them. Or @mention the bot in a channel of your own and choose **Work**, **Status** or **Chat**. A channel hears nothing until it is allowed one of these ways, and your direct chat never gets ticket threads.
5. **Work.** Move a ticket to Doing or Verifying: it gets a thread in the work channel, renamed as it moves and archived when it is done. The status channel gets ticket and code news; the chat channel answers when you @mention or reply to the bot.

What each feature needs:

| Feature | Permissions |
|---|---|
| Answering in channels, cards, the status and chat channels | View Channels, Send Messages, Read Message History, Embed Links |
| A thread per ticket | Create Public Threads, Send Messages in Threads, Manage Threads (rename and archive); in a forum or media channel a post, which needs Send Messages |
| Files | Attach Files |
| 👀 / ✅ / ❌ on your messages | Add Reactions |
| `/tomrade setup` | Manage Channels (optional; untick it when adding the bot if you create the channels yourself) |

A permission that is missing is said once in the channel where it bit, naming it, with the install link to add the bot again; Settings → IM shows it on the connection too.

What the adapter does:

- Gateway with heartbeats; a dropped or silent connection resumes and Discord replays what was missed (the IM layer keeps each event once).
- Buttons, string selects (multi-select through `max_values`) and a modal for free text; every interaction is acknowledged within Discord's three seconds.
- Replies quote the message that asked (`message_reference`); messages inside a thread stay in it.
- A thread per ticket being worked, in a channel whose conversation has "A thread per ticket" on (the default): a public thread in a text channel, a post in a forum or media channel. Its name carries the ticket's key, status and title and follows the ticket; it is archived once the ticket is done and opened again if the ticket comes back. @mention the bot in the thread to talk about the ticket there. The bot needs **Create Public Threads**, **Send Messages in Threads** and **Manage Threads**.
- A permission the bot lacks in a channel is said there once, naming it, with the install link (or in your direct chat when the bot cannot post there), and shows on the connection in Settings → IM. Nothing is retried in a loop; once granted, the next call works.
- `/tomrade setup` (the paired person, in a server): creates a **Tomrade** category with work, status and chat channels for a project and allows them: the work channel gets a thread per ticket being worked, the status channel ticket and code news, the chat channel talks to the assistant. Run it again to put back a deleted channel; it changes nothing else. It needs **Manage Channels**, which the install link asks for and you may untick.
- 👀 when a message is taken, ✅ or ❌ when its turn ends; typing while it works.
- Sections as embeds; `tomrade://` links are shown as text, since Discord link buttons take web links only.
- 2000-character messages, files up to 10 MB both ways, five messages a channel every five seconds; a 429 waits as long as Discord says, and a message is never posted twice (enforced nonce).

`src/fake.ts` is an in-memory Discord used by the tests and by `tomrade-plugin test` (`src/test.ts`).
