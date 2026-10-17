# DingTalk

Talk to a Tomrade project's assistant from DingTalk (钉钉): direct chats, and @mentions in groups. Replies stream into an AI card, questions and approvals come as card buttons, and files go both ways. Tomrade connects from this computer over DingTalk's Stream mode; nothing runs in the cloud and no public address is needed, so the robot answers only while Tomrade is open.

Set it up in Settings → IM → Connect a bot → 钉钉 DingTalk. The wizard lists the developer-console steps: an internal app with the Robot capability in Stream mode, its Client ID and Client Secret (stored encrypted on this computer), the robot and card permissions, and a published version. The RobotCode and an AI card template ID are optional.

What the adapter does:

- Stream mode: registers for a socket address and a single-use ticket, subscribes to robot messages and card callbacks, and answers every frame, pings included. A `disconnect` notice, or a socket that has heard nothing for three minutes, brings a new connection up before the old one closes; a drop reconnects with backoff through a fresh ticket. A message DingTalk delivers twice runs once.
- Direct chats are addressed by the person (`user:<userId>`), so a reply reaches them after a restart; groups by their conversation id. In a group the robot hears only messages that @ it; a quote of its own message counts as a reply, and the quoted text goes along as context.
- Replies are AI cards on DingTalk's public AI card template (or the one set in the wizard): Markdown, sections and web links, edited in place, and streamed while the reply is written. Buttons call back over Stream; every press is answered inside DingTalk's three seconds, and the card loses its buttons once the question is handled. Selects, multi-selects and free-text answers use `/answer`, as do buttons beyond six. `tomrade://` links show as text.
- In a group, the first reply to a message @s the person who sent it.
- A "🤔思考中" text emotion on the message being worked on, taken away when its turn ends.
- Without the card permissions (or with a template DingTalk refuses) replies fall back to Markdown messages, with buttons as `/answer` lines and a streamed reply posted once it settles; the plugin log says why. Those go through the conversation's session webhook while it lasts, and through the robot's own API (one-to-one batch send, group send) once it has lapsed or for a message nobody asked for.
- Files both ways: images up to 10 MB go as images, other files up to 20 MB as files, uploaded first and sent through the robot's API; incoming pictures and files (and rich-text pictures) are fetched through their download code with their real size and type. A voice message arrives as its transcript.
- Commands are plain text (`/new`, `/stop`, `/status`, …).
- Two messages or edits a second per conversation; a rate limit waits as DingTalk's gate says, a stale token is renewed, a card is never posted twice for one delivery, and a robot message lost in flight is reported as uncertain rather than sent again.

The download addresses DingTalk hands out point at its file storage on Alibaba Cloud (`*.aliyuncs.com`), which is why that host is declared beside `dingtalk.com`.

`src/fake.ts` is an in-memory DingTalk used by the tests and by `tomrade-plugin test` (`src/test.ts`).
