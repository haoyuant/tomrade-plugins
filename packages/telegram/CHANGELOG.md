# Changelog

## 0.4.0

- Settings → IM shows a group by its title and a direct chat by the person in it, instead of its id (SDK 0.2.24 `describe`, from `getChat`).

## 0.3.0

- **Add the bot to a group**: once connected, the connection in Settings → IM offers a `t.me/<bot>?startgroup` link that asks to make the bot an admin with exactly the right it uses (Manage Topics).
- A topic refused because the group has no Topics, or because the bot lacks Manage Topics, is said once per group with what to change and the link (SDK 0.2.20 notices), and cleared once topics work there again. The ticket's news stays in the group as before.
- Settings → IM shows Telegram's own steps for using a group (SDK 0.2.22 `groupSteps`); the README has the same steps and what each feature needs.

## 0.2.0

- A forum topic per ticket being worked (Tomrade's ticket topics, SDK 0.2.19), in a supergroup with Topics on: its name carries the ticket's key, status and title and follows the ticket; it is closed once the ticket is done and opened again if the ticket comes back. The bot must be an admin with the right to manage topics; in a group without Topics the ticket's news stays in the group.

## 0.1.0

- Telegram over Bot API long polling: direct chats, @mentions, replies and commands in groups, forum topics, buttons for questions and choices, and replies that stream as drafts; messages sent while Tomrade was closed are answered once when it opens.
