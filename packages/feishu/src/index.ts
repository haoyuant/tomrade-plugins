import { definePlugin, type ImAdapterSetup } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openFeishu } from "./adapter.js";
import type { Domain } from "./api.js";

const PERMISSIONS = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:readonly",
  "im:resource",
  "im:message.reactions:write_only",
  "cardkit:card:write",
  "contact:user.base:readonly (optional)",
  "im:message.group_msg (optional)"
];

/** The same console in both products; only its address and the app's name differ. */
function setup(domain: Domain): ImAdapterSetup {
  const lark = domain === "lark";
  const site = lark ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app";
  const app = lark ? "Lark" : "Feishu";
  const appZh = lark ? "Lark" : "飞书";
  return {
    fields: [
      { key: "appId", placeholder: "cli_…", label: { en: "App ID", zh: "App ID" },
        help: { en: "Credentials & Basic Info in the developer console.", zh: "在开发者后台的「凭证与基础信息」页。" } },
      { key: "appSecret", secret: true, label: { en: "App Secret", zh: "App Secret" },
        help: { en: "Stored encrypted on this computer.", zh: "只加密保存在这台电脑上。" } }
    ],
    steps: [
      { en: `In the ${app} developer console (${site}), create a **custom app** for your organization.`, zh: `在${appZh}开放平台（${site}）创建**企业自建应用**。` },
      { en: "Under **Add features**, add **Bot**.", zh: "在「添加应用能力」里添加**机器人**。" },
      { en: "Copy the **App ID** and **App Secret** from **Credentials & Basic Info** into the fields below, then save and connect. The console only accepts the long connection once Tomrade is connected.",
        zh: "从「凭证与基础信息」复制 **App ID** 和 **App Secret** 填到下面，保存并连接。开发者后台要在 Tomrade 连上之后才能保存长连接设置。" },
      { en: "Under **Permissions & Scopes**, add the scopes listed here. The optional ones show people's names, and let the bot follow a topic without being @mentioned.",
        zh: "在「权限管理」开通下面列出的权限。标了 optional 的是可选的：一个用于显示发消息人的名字，一个让机器人在话题里不用 @ 也能接着回复。" },
      { en: "Under **Events & Callbacks → Event configuration**, choose **Receive events through persistent connection** and add `im.message.receive_v1`. Optionally add `im.message.recalled_v1` (a withdrawn message never runs) and `application.bot.menu_v6` (bot menu).",
        zh: "在「事件与回调 → 事件配置」把订阅方式设为**使用长连接接收事件**，添加 `im.message.receive_v1`（接收消息）。可选再加 `im.message.recalled_v1`（撤回的消息不再执行）和 `application.bot.menu_v6`（机器人菜单）。" },
      { en: "Under **Events & Callbacks → Callback configuration**, also choose the persistent connection and add `card.action.trigger`. Without it buttons show but answer with error 200340 when pressed.",
        zh: "在「事件与回调 → 回调配置」同样选**使用长连接接收回调**，添加 `card.action.trigger`（卡片回传交互）。不加的话按钮能显示，但一点就报错 200340。" },
      { en: "Under **Version Management & Release**, create a version and publish it, with yourself (and the people in the groups you'll use) in its availability.",
        zh: "在「版本管理与发布」创建版本并发布，可用范围要包含你自己，以及要在群里使用它的成员。" },
      { en: `In ${app}, find the bot and send it the pairing code from Tomrade in a direct chat. Add it to a group and @mention it to use it there; a reply written in a topic stays in that topic.`,
        zh: `在${appZh}里搜索这个机器人，私聊发送 Tomrade 里的配对码。把它拉进群并 @ 它就能在群里用；在话题里提问，回复也会留在话题里。` },
      { en: "Optional: under **Bot → Custom menu**, add entries that **push an event**, with the command as the event key (`new`, `stop`, `status`, `sessions`, …).",
        zh: "可选：在「机器人 → 自定义菜单」添加菜单项，动作选**推送事件**，事件 key 填指令名（`new`、`stop`、`status`、`sessions` 等）。" }
    ],
    permissions: PERMISSIONS,
    docsUrl: site,
    groupSteps: [
      { en: `In the group, open its settings → **Bots** → **Add bot** and pick the app. It must be published, with the group's members in its availability.`,
        zh: `在群里打开群设置 → **群机器人** → **添加机器人**，选择这个应用。应用要已发布，可用范围包含群里的成员。` },
      { en: "@mention the bot in the group and choose what it is for: Work, Status (news only) or Chat (talk to the assistant).", zh: "在群里 @机器人，选择这个群的用途：工作、状态（只推送消息）或聊天（和助手对话）。" },
      { en: `Move a ticket to Doing: in a work group it gets a card of its own, and the ticket's news goes into that card's topic.`,
        zh: `把一个工单移到「进行中」：在工作群里它会有一张自己的卡片，工单的动态都发在这张卡片的话题里。` }
    ]
  };
}

/** Feishu and Lark over the long connection: direct chats, @mentions and topics in groups, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    for (const [id, title, domain] of [["feishu", "飞书 Feishu", "feishu"], ["feishu-lark", "Lark", "lark"]] as const) {
      await ctx.im.register({
        id, title, capabilities: CAPABILITIES, setup: setup(domain),
        open: (connectionId, io) => openFeishu(connectionId, io, { domain })
      });
    }
  }
});
