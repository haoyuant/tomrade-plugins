import { definePlugin, type ImAdapterSetup } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openWecom } from "./adapter.js";
import { SERVER } from "./gateway.js";

const DOCS = "https://developer.work.weixin.qq.com/document/path/101463";

const SETUP: ImAdapterSetup = {
  fields: [
    { key: "botId", label: { en: "Bot ID", zh: "Bot ID" },
      help: { en: "Shown on the bot's API settings once the long connection is chosen.", zh: "选择长连接后，在机器人的 API 配置页显示。" } },
    { key: "secret", secret: true, label: { en: "Secret", zh: "Secret" },
      help: { en: "Stored encrypted on this computer.", zh: "只加密保存在这台电脑上。" } },
    { key: "server", optional: true, placeholder: SERVER, label: { en: "Long-connection address", zh: "长连接地址" },
      help: { en: "Only for a private deployment: the address its admin console shows. Leave empty otherwise.", zh: "仅私有部署需要填写管理后台显示的地址，其他情况留空。" } }
  ],
  steps: [
    { en: "In the WeCom app, open **Workbench → Intelligent bots** and choose **Create bot → Create manually**, then **Create in API mode**. If it is not offered, an admin allows you under **Admin console → AI → Intelligent bots → Permissions → API mode**.",
      zh: "在企业微信客户端打开「工作台 → 智能机器人」，选择「创建机器人 → 手动创建」，再选「API模式创建」。没有这个入口时，请管理员在「管理后台 → 智能专区 → 智能机器人 → 权限管理 → API 模式管理」里给你授权。" },
    { en: "Set the connection method to **Use long connection**. No callback URL, public address or trusted IP is needed.",
      zh: "连接方式选择**使用长连接**，不需要回调地址、公网地址或可信 IP。" },
    { en: "Copy the **Bot ID** and **Secret** into the fields below, then save and connect. WeCom keeps one long connection per bot: connecting here disconnects anything else using this bot.",
      zh: "把页面上的 **Bot ID** 和 **Secret** 填到下面，保存并连接。每个机器人同时只能有一条长连接，在这里连上会断开其他地方对这个机器人的连接。" },
    { en: "Under **Visible range**, include yourself and the people in the groups you'll use, then save the bot. API mode has no preview; save it directly.",
      zh: "在「可见范围」里加入你自己，以及要在群里使用它的成员，然后保存。API 模式不支持预览调试，直接保存即可。" },
    { en: "In WeCom, open a direct chat with the bot and send it the pairing code from Tomrade. To use it in a group, add it to the group and @mention it; replies answer the message that asked.",
      zh: "在企业微信里打开和机器人的单聊，发送 Tomrade 里的配对码。要在群里使用，把它加进群并 @ 它，回复会针对提问的那条消息。" },
    { en: "Commands are plain text (`/new`, `/stop`, `/status`, `/help`, …). Questions come as cards with buttons or choices; a free-text answer is `/answer` followed by the text the card names.",
      zh: "指令直接发文字（`/new`、`/stop`、`/status`、`/help` 等）。问题以带按钮或选项的卡片发来；需要自由回答时，按卡片提示发送 `/answer` 加回答。" }
  ],
  docsUrl: DOCS,
  groupSteps: [
    { en: "Add the bot to the group from the group's settings; it must have the group's members in its visible range.", zh: "在群设置里把机器人加进群；它的可见范围要包含群里的成员。" },
    { en: "@mention the bot in the group and choose what it is for: Work, Status (news only) or Chat (talk to the assistant).", zh: "在群里 @机器人，选择这个群的用途：工作、状态（只推送消息）或聊天（和助手对话）。" },
    { en: "WeCom groups have no topics: in a work group, each ticket's news is a line in the group, answering nobody in particular.", zh: "企业微信群没有话题：在工作群里，每个工单的动态在群里发一行。" }
  ]
};

/** WeCom's intelligent bot over its long connection: direct chats and @mentions in groups, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({
      id: "wecom", title: "企业微信 WeCom", capabilities: CAPABILITIES, setup: SETUP,
      open: (connectionId, io) => openWecom(connectionId, io)
    });
  }
});
