import { definePlugin, type ImAdapterSetup } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openDingTalk } from "./adapter.js";
import { TEMPLATE } from "./card.js";

const CONSOLE = "https://open-dev.dingtalk.com";

const SETUP: ImAdapterSetup = {
  fields: [
    { key: "clientId", placeholder: "ding…", label: { en: "Client ID (AppKey)", zh: "Client ID（原 AppKey）" },
      help: { en: "Credentials & Basic Info in the developer console.", zh: "在开发者后台的「凭证与基础信息」页。" } },
    { key: "clientSecret", secret: true, label: { en: "Client Secret (AppSecret)", zh: "Client Secret（原 AppSecret）" },
      help: { en: "Stored encrypted on this computer.", zh: "只加密保存在这台电脑上。" } },
    { key: "robotCode", optional: true, label: { en: "RobotCode", zh: "RobotCode" },
      help: { en: "Only when the robot's page shows a RobotCode other than the Client ID (older apps).", zh: "只有机器人页面上的 RobotCode 和 Client ID 不同时才需要填（较早创建的应用）。" } },
    { key: "cardTemplateId", optional: true, placeholder: TEMPLATE, label: { en: "AI card template ID", zh: "AI 卡片模板 ID" },
      help: { en: "Leave empty to use DingTalk's public AI card template. A template of your own must keep its variables: msgContent, staticMsgContent, flowStatus and sys_full_json_obj.",
        zh: "留空即使用钉钉公开的 AI 卡片模板。自建模板需保留这些变量：msgContent、staticMsgContent、flowStatus、sys_full_json_obj。" } }
  ],
  steps: [
    { en: `In the DingTalk developer console (${CONSOLE}), create an **internal app** for your organization.`, zh: `在钉钉开发者后台（${CONSOLE}）创建**企业内部应用**。` },
    { en: "Under **Add capabilities**, add **Robot**, give it a name and an avatar, and set **Message receiving mode** to **Stream mode**.",
      zh: "在「添加应用能力」里添加**机器人**，填好名称和头像，**消息接收模式**选 **Stream 模式**。" },
    { en: "Copy the **Client ID** and **Client Secret** from **Credentials & Basic Info** into the fields below, then save and connect. Fill in RobotCode only when the robot's page shows a different one.",
      zh: "从「凭证与基础信息」复制 **Client ID** 和 **Client Secret** 填到下面，保存并连接。机器人页面上的 RobotCode 和 Client ID 不同时才需要填写。" },
    { en: "Under **Permissions**, grant the permissions listed here: the robot sends messages and reads the files people send it, and posts AI cards. Without the two card permissions replies come as plain Markdown messages, without buttons or streaming.",
      zh: "在「权限管理」开通下面列出的权限：机器人发消息、读取别人发给它的文件、发送 AI 卡片。不开通两个卡片权限的话，回复会变成普通 Markdown 消息，没有按钮，也不会边写边更新。" },
    { en: `Optional: replies use DingTalk's public AI card template. To use your own, create an AI card template in the card platform (${CONSOLE}/fe/card) and enter its template ID below.`,
      zh: `可选：回复默认使用钉钉公开的 AI 卡片模板。要用自己的模板，在卡片平台（${CONSOLE}/fe/card）创建 AI 卡片模板，把模板 ID 填到下面。` },
    { en: "Under **Version Management & Release**, create a version and publish it, with yourself (and the people in the groups you'll use) in its visible range. DingTalk names the people who write to the robot only once it is published.",
      zh: "在「版本管理与发布」创建版本并发布，可见范围要包含你自己，以及要在群里使用它的成员。应用发布后钉钉才会告诉机器人是谁发的消息。" },
    { en: "In DingTalk, find the robot and send it the pairing code from Tomrade in a direct chat. To use it in a group, add it under the group's **Settings → Robots → Add robot** and @mention it; the first reply @s you back.",
      zh: "在钉钉里搜索这个机器人，私聊发送 Tomrade 里的配对码。要在群里使用，在「群设置 → 机器人 → 添加机器人」里加入它，再 @ 它提问；第一条回复会 @ 回你。" }
  ],
  permissions: ["qyapi_robot_sendmsg", "Card.Instance.Write", "Card.Streaming.Write"],
  docsUrl: CONSOLE,
  groupSteps: [
    { en: "In the group, open **Settings → Robots → Add robot** and pick the robot.", zh: "在群里打开「群设置 → 机器人 → 添加机器人」，选择这个机器人。" },
    { en: "@mention the bot in the group and choose what it is for: Work, Status (news only) or Chat (talk to the assistant).", zh: "在群里 @机器人，选择这个群的用途：工作、状态（只推送消息）或聊天（和助手对话）。" },
    { en: "DingTalk groups have no topics: in a work group, each ticket's news is a line in the group.", zh: "钉钉群没有话题：在工作群里，每个工单的动态在群里发一行。" }
  ]
};

/** DingTalk over Stream mode: direct chats and @mentions in groups, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({
      id: "dingtalk", title: "钉钉 DingTalk", capabilities: CAPABILITIES, setup: SETUP,
      open: (connectionId, io) => openDingTalk(connectionId, io, { warn: message => ctx.logger.warn(message) })
    });
  }
});
