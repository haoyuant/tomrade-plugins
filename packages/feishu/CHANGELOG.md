# Changelog

## 0.3.0

- A post refused because the bot left the group, the app lacks a permission (naming the scopes Feishu names, with the console's permission page) or the bot may not do it in that group is said once per group (SDK 0.2.20 notices) and cleared once a post works there again.
- Settings → IM shows Feishu's own steps for using a group (SDK 0.2.22 `groupSteps`); the README has the same steps.

## 0.2.0

- A topic per ticket being worked in a group (Tomrade's ticket topics, SDK 0.2.19): its first message is a card naming the ticket with its status, the ticket's news is replied into its thread, and the card follows the ticket, with a ✅ once it is done. People's messages in it reach the ticket's conversation, without an @ when `im:message.group_msg` is granted. No topic opens in a direct chat.

## 0.1.0

- Feishu and Lark IM over the long connection: direct chats, @mentions and topics in groups, card buttons, selects and forms for questions, and replies that stream into a card.
