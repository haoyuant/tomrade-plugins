# Changelog

## 0.6.0

- Settings → IM shows a server channel as `#name` and a direct chat by the person in it, instead of its id (SDK 0.2.24 `describe`); `/tomrade setup` names the channels it allows.

## 0.5.0

- Settings → IM shows, under a connected Discord bot, how to use it in a server (SDK 0.2.22 `groupSteps`): add the bot with its install link, run `/tomrade setup` or @mention it in a channel, then move a ticket to Doing to see its thread. The README follows the same steps and lists the permission each feature needs.

## 0.4.0

- `/tomrade setup`, run in a server by the person paired with Tomrade, creates a **Tomrade** category with `#tomrade-work` (a thread per ticket being worked), `#tomrade-status` (news only) and `#tomrade-chat` (talk to the assistant), in the person's language, and allows each with that preset (SDK 0.2.21). Channels it made before, found by the mark in their topic, and channels of those names are reused; nothing is deleted, so a rerun only puts back what is missing. With several projects it takes a `project` option (autocompleted), and a second project set up in the same server gets channels named after it. Without **Manage Channels** it says so with the install link; anyone not paired gets a polite refusal. On an older Tomrade the subcommand is not offered.
- The install link also asks for **Manage Channels**, optional: untick it if you will create the channels yourself.

## 0.3.0

- An install link: once connected, the connection in Settings → IM shows **Add the bot to a server**, and the pairing reply carries it. It asks for exactly the permissions the setup lists, with the `bot` and `applications.commands` scopes; the Developer Portal's Installation page is only the fallback.
- A missing permission is said where it bites: when Discord refuses opening, renaming or archiving a thread, posting or reacting for a permission the bot lacks (50013, or 50001 for a channel it cannot see), the channel hears one line naming the permission with the install link, once per channel and permission, and Settings → IM shows it on the connection (SDK 0.2.20 notices; on an older Tomrade the bot posts the line itself). The ticket's news stays in the channel's main conversation; once the permission is granted the next thread opens without a restart.

## 0.2.0

- A thread per ticket being worked (Tomrade's ticket topics, SDK 0.2.19): a public thread in a text channel, an announcement thread in an announcement channel, a post in a forum or media channel. Its name follows the ticket's status, and it is archived once the ticket is done. The bot now asks for Create Public Threads and Manage Threads.

## 0.1.0

- Discord over the Gateway, moved out of the Tomrade app: direct messages, @mentions and replies in channels and threads, buttons, selects and a form for questions, and the `/tomrade` command; a dropped connection resumes and what was missed is replayed once.
