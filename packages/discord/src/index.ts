import { definePlugin } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openDiscord } from "./adapter.js";
import { OPTIONAL_PERMISSIONS, PERMISSIONS } from "./wire.js";

/** Discord over the Gateway: direct messages, @mentions and replies in channels and threads, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({
      id: "discord",
      title: "Discord",
      capabilities: CAPABILITIES,
      setup: {
        fields: [{
          key: "botToken", secret: true, placeholder: "MTEx…",
          label: { en: "Bot token", zh: "机器人令牌（Bot Token）" },
          help: { en: "Bot → Reset Token in the Developer Portal. It is stored encrypted on this computer.", zh: "在开发者后台的 Bot → Reset Token 生成。只加密保存在这台电脑上。" }
        }, {
          key: "messageContent", optional: true, placeholder: "on",
          label: { en: "Read channel messages (optional)", zh: "读取频道消息（可选）" },
          help: { en: "Type on only after turning on Message Content Intent in the portal; otherwise Discord refuses the connection. Needed for a group's recent-discussion window.", zh: "先在开发者后台打开 Message Content Intent，再在这里填 on；没打开就填会被 Discord 拒绝连接。群聊的「最近讨论」窗口需要它。" }
        }],
        steps: [
          { en: "Open the Discord Developer Portal and create a **New Application**.", zh: "打开 Discord 开发者后台，点 **New Application** 新建应用。" },
          { en: "In **Bot**, press **Reset Token** and copy it into the field below. Privileged intents can stay off: mentions and direct messages carry their text without Message Content.", zh: "在 **Bot** 页点 **Reset Token**，把令牌复制到下面。特权 Intent 都可以不开：@ 机器人和私信本身就带正文，不需要 Message Content。" },
          { en: "Optional: to let the assistant see a channel's recent discussion when @mentioned, turn on **Message Content Intent** under **Bot**, type `on` in the optional field below, and turn on the window for that group in its route. Off by default; the messages stay on this computer.", zh: "可选：想让助手被 @ 时看到频道最近的讨论，在 **Bot** 页打开 **Message Content Intent**，在下面的可选字段填 `on`，再在该群的路由里打开上下文窗口。默认关闭；消息只保存在这台电脑上。" },
          { en: "Save and connect. The connection then shows **Add the bot to a server**: open it, pick your server and authorize. It asks for exactly the permissions listed here. If the link does not show, use **Installation** in the portal instead: Guild Install with the scopes `bot` and `applications.commands` and these permissions.", zh: "保存并连接。连上后连接卡片上会出现 **把机器人加到服务器**：打开它，选择服务器并授权，它申请的正好是下面列出的权限。如果没有出现这个链接，就改用开发者后台的 **Installation**：Guild Install，勾选 `bot` 和 `applications.commands` 两个 scope 以及这些权限。" },
          { en: "Send the bot a direct message with the pairing code from Tomrade. Then run **/tomrade setup** in your server: it creates a Tomrade category with work, status and chat channels and allows them. Or @mention the bot in any channel and choose what that channel is for.", zh: "私信机器人发送 Tomrade 里的配对码。然后在服务器里运行 **/tomrade setup**：它会创建 Tomrade 分类和工作、状态、聊天三个频道并允许它们。也可以在任意频道 @ 机器人，选择这个频道的用途。" }
        ],
        permissions: PERMISSIONS.map(([name]) => OPTIONAL_PERMISSIONS.includes(name) ? `${name} (optional: /tomrade setup)` : name),
        docsUrl: "https://discord.com/developers/applications",
        groupSteps: [
          { en: "Add the bot to your server with **Add the bot to a server** on this connection; it asks for exactly the permissions it needs.", zh: "用这个连接上的 **把机器人加到服务器** 把机器人加到你的服务器，它申请的正好是所需的权限。" },
          { en: "In the server, run **/tomrade setup**: it creates a Tomrade category with work, status and chat channels and allows them. Or @mention the bot in any channel and choose Work, Status or Chat.", zh: "在服务器里运行 **/tomrade setup**：它会创建 Tomrade 分类和工作、状态、聊天三个频道并允许它们。也可以在任意频道 @机器人，选择工作、状态或聊天。" },
          { en: "Move a ticket to Doing: its thread appears in the work channel.", zh: "把一个工单移到「进行中」：工作频道里就会出现它的话题。" }
        ]
      },
      open: (connectionId, io) => openDiscord(connectionId, io)
    });
  }
});
