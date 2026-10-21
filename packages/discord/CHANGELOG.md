# Changelog

## 0.3.0

- An install link: once connected, the connection in Settings → IM shows **Add the bot to a server**, and the pairing reply carries it. It asks for exactly the permissions the setup lists, with the `bot` and `applications.commands` scopes; the Developer Portal's Installation page is only the fallback.
- A missing permission is said where it bites: when Discord refuses opening, renaming or archiving a thread, posting or reacting for a permission the bot lacks (50013, or 50001 for a channel it cannot see), the channel hears one line naming the permission with the install link, once per channel and permission, and Settings → IM shows it on the connection (SDK 0.2.20 notices; on an older Tomrade the bot posts the line itself). The ticket's news stays in the channel's main conversation; once the permission is granted the next thread opens without a restart.

## 0.2.0

- A thread per ticket being worked (Tomrade's ticket topics, SDK 0.2.19): a public thread in a text channel, an announcement thread in an announcement channel, a post in a forum or media channel. Its name follows the ticket's status, and it is archived once the ticket is done. The bot now asks for Create Public Threads and Manage Threads.

## 0.1.0

- Discord over the Gateway, moved out of the Tomrade app: direct messages, @mentions and replies in channels and threads, buttons, selects and a form for questions, and the `/tomrade` command; a dropped connection resumes and what was missed is replayed once.
