import { definePlugin } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openTelegram } from "./adapter.js";

/** Telegram over Bot API long polling: direct chats, @mentions, replies and commands in groups, and forum topics, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({
      id: "telegram",
      title: "Telegram",
      capabilities: CAPABILITIES,
      setup: {
        fields: [{
          key: "botToken", secret: true, placeholder: "123456789:AA…",
          label: { en: "Bot token", zh: "机器人令牌（Bot Token）" },
          help: { en: "The token @BotFather sent when the bot was created. Stored encrypted on this computer.", zh: "创建机器人时 @BotFather 发给你的令牌。只加密保存在这台电脑上。" }
        }],
        steps: [
          { en: "In Telegram, open **@BotFather** and send `/newbot`. Pick a name, then a username ending in `bot`; BotFather answers with the bot's token.",
            zh: "在 Telegram 里打开 **@BotFather**，发送 `/newbot`。先起一个名字，再起一个以 `bot` 结尾的用户名；BotFather 会回复这个机器人的令牌（token）。" },
          { en: "Copy the token into the field below, save and connect. Tomrade asks Telegram for the bot's messages from this computer, so the bot answers only while Tomrade is open; what people send meanwhile waits at Telegram for up to 24 hours and is answered once when Tomrade opens again.",
            zh: "把令牌复制到下面，保存并连接。Tomrade 在这台电脑上向 Telegram 拉取机器人的消息，所以只有 Tomrade 开着时机器人才会回复；关着时别人发的消息会在 Telegram 保留最多 24 小时，下次打开时补收并且只处理一次。" },
          { en: "Use a bot made for Tomrade. A bot that already delivers its updates to a webhook can't be read this way and fails to connect; removing that webhook (`deleteWebhook`) stops whatever service set it.",
            zh: "请用专门给 Tomrade 的机器人。如果这个机器人已经设置了 webhook（交给别的服务接收消息），Tomrade 读不到它的消息，连接会失败；删除 webhook（`deleteWebhook`）会让原来的服务收不到消息。" },
          { en: "Open the bot in Telegram, press **Start**, and send it the pairing code from Tomrade in this direct chat.",
            zh: "在 Telegram 里打开这个机器人，点 **开始（Start）**，然后在私聊里发送 Tomrade 里的配对码。" },
          { en: "To use it in a group, add the bot and @mention it, reply to one of its messages, or send a command such as `/status@your_bot`. Bots start in privacy mode and see only those messages, which is all a conversation needs.",
            zh: "要在群里用：把机器人拉进群，然后 @ 它、回复它的消息，或者发送 `/status@你的机器人` 这样的指令。机器人默认开着隐私模式，只能看到这几类消息，日常对话这就够了。" },
          { en: "Optional: to let the assistant see a group's recent discussion when it is woken (the route's context window), send `/setprivacy` to @BotFather, pick the bot and choose **Disable**, then remove the bot from the group and add it back; Telegram applies the change when it rejoins.",
            zh: "可选：想让助手被唤起时看到群里最近的讨论（路由里的「上下文窗口」），给 @BotFather 发 `/setprivacy`，选中这个机器人并选 **Disable** 关闭隐私模式，然后把机器人移出群再重新拉进来；Telegram 要在重新入群后才生效。" },
          { en: "In a group with **Topics** turned on, ask inside a topic and the answer stays in that topic; each topic is a conversation of its own.",
            zh: "在开启了 **话题（Topics）** 的群里，在某个话题里提问，回复也会留在这个话题里；每个话题各是一段独立的会话。" },
          { en: "For a topic per ticket being worked (named with its status, closed once it is done), turn on **Topics** for the group and make the bot an admin with the **Manage Topics** right. Without them, a ticket's news stays in the group.",
            zh: "想让每个正在处理的工单各有一个话题（标题带着工单状态，完成后自动关闭），请为群开启 **话题（Topics）**，并把机器人设为管理员、给它 **管理话题（Manage Topics）** 权限。否则工单的动态仍发在群里。" },
          { en: "Commands such as `/new`, `/stop`, `/status` and `/help` appear in the bot's menu once Tomrade is connected. Questions come with buttons; to answer in your own words, press ✍️ and reply.",
            zh: "连接后，`/new`、`/stop`、`/status`、`/help` 等指令会出现在机器人的菜单里。提问会带按钮；要用自己的话回答，点 ✍️ 后直接回复即可。" }
        ],
        // No docs link: the plugin names no host but api.telegram.org, and @BotFather lives in Telegram itself.
        groupSteps: [
          { en: "Add the bot to your group with **Add the bot to a group** on this connection; Telegram asks to make it an admin with **Manage Topics**, which a topic per ticket needs.",
            zh: "用这个连接上的 **把机器人加到群** 把机器人加进你的群；Telegram 会请你把它设为有 **管理话题（Manage Topics）** 权限的管理员，每个工单一个话题需要这个权限。" },
          { en: "For a topic per ticket, turn on **Topics** in the group's settings. Without them the group still works, with each ticket's news as a line in the group.",
            zh: "想要每个工单一个话题，请在群设置里开启 **话题（Topics）**。不开也能用，只是每个工单的动态在群里发一行。" },
          { en: "@mention the bot in the group and choose what it is for: Work, Status or Chat. With privacy mode on (the default) the bot sees only @mentions, replies to it and commands.",
            zh: "在群里 @机器人，选择这个群的用途：工作、状态或聊天。隐私模式开着时（默认），机器人只能看到 @它的消息、回复它的消息和指令。" },
          { en: "Move a ticket to Doing: in a work group with Topics, it gets a topic of its own.",
            zh: "把一个工单移到「进行中」：在开启了话题的工作群里，它会有自己的话题。" }
        ]
      },
      open: (connectionId, io) => openTelegram(connectionId, io)
    });
  }
});
