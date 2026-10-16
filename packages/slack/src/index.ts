import { definePlugin, type ImAdapterSetup } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openSlack } from "./adapter.js";

const SCOPES = [
  "app_mentions:read", "chat:write", "im:history", "reactions:write", "files:read", "files:write", "users:read", "commands", "assistant:write",
  "channels:history", "groups:history"
];
const EVENTS = ["app_mention", "message.im", "message.channels", "message.groups", "agent_session_stopped"];

/** Pasted at api.slack.com/apps → Create New App → From a manifest. Socket Mode needs no request URLs. */
export const MANIFEST = `display_information:
  name: Tomrade
  description: Talk to your Tomrade project's assistant from Slack.
  background_color: "#2b2d31"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Tomrade
    always_online: false
  agent_view:
    agent_description: Talks to the assistant of your Tomrade project, running on your own computer while Tomrade is open.
    suggested_prompts:
      - title: What's in progress?
        message: What is in progress right now?
      - title: Plan my next step
        message: What should I work on next?
  slash_commands:
    - command: /tomrade
      description: Run a Tomrade command, or say something to the assistant
      usage_hint: status | stop | new | sessions | switch N | help | pair CODE
      should_escape: false
oauth_config:
  scopes:
    bot:
${SCOPES.map(s => `      - ${s}`).join("\n")}
settings:
  event_subscriptions:
    bot_events:
${EVENTS.map(e => `      - ${e}`).join("\n")}
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

const setup: ImAdapterSetup = {
  fields: [
    { key: "appToken", secret: true, placeholder: "xapp-…", label: { en: "App-Level Token", zh: "App-Level Token" },
      help: { en: "Basic Information → App-Level Tokens, with the connections:write scope. Stored encrypted on this computer.", zh: "在「Basic Information → App-Level Tokens」生成，scope 选 connections:write。只加密保存在这台电脑上。" } },
    { key: "botToken", secret: true, placeholder: "xoxb-…", label: { en: "Bot Token", zh: "Bot Token" },
      help: { en: "Install App → Bot User OAuth Token. Stored encrypted on this computer.", zh: "在「Install App」页的 Bot User OAuth Token。只加密保存在这台电脑上。" } }
  ],
  steps: [
    { en: "At api.slack.com/apps choose **Create New App → From a manifest**, pick your workspace and paste the manifest below. It turns on Socket Mode, the bot's events and scopes, buttons, the `/tomrade` command and the agent view.",
      zh: "在 api.slack.com/apps 选择 **Create New App → From a manifest**，选好工作区，粘贴下面的 manifest。它会打开 Socket Mode，配好机器人的事件和权限、按钮交互、`/tomrade` 指令和 Agent 视图。" },
    { en: "Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope and paste it (`xapp-…`) below.",
      zh: "在「Basic Information → App-Level Tokens」生成一个带 `connections:write` 权限的 token，把它（`xapp-…`）填到下面。" },
    { en: "Under **Install App**, install the app to your workspace and paste the **Bot User OAuth Token** (`xoxb-…`) below, then save and connect. Socket Mode apps serve your own workspace only; they can't be listed in the Slack Marketplace.",
      zh: "在「Install App」把应用安装到工作区，把 **Bot User OAuth Token**（`xoxb-…`）填到下面，保存并连接。Socket Mode 应用只供自己的工作区使用，不能上架 Slack Marketplace。" },
    { en: "In Slack, open the app's **Messages** tab and send `/tomrade pair` followed by the pairing code from Tomrade. Slack takes any message that starts with `/` as a command, so every Tomrade command goes the same way: `/tomrade status`, `/tomrade stop`, `/tomrade help`.",
      zh: "在 Slack 打开应用的 **Messages** 页，发送 `/tomrade pair` 加上 Tomrade 里的配对码。Slack 会把以 `/` 开头的消息都当成指令，所以 Tomrade 的指令都这样用：`/tomrade status`、`/tomrade stop`、`/tomrade help`。" },
    { en: "Each message you send in the Messages tab starts its own conversation, answered in its thread; reply in the thread to continue it. The \"thinking\" status and the stop button show there while a reply is on its way.",
      zh: "在 Messages 页每发一条消息就开始一个新对话，回复在它的话题（thread）里；在话题里回复就能接着聊。回答生成时，那里会显示“思考中”和停止按钮。" },
    { en: "Invite the app to a channel (`/invite @Tomrade`) and @mention it there. It answers in the thread of the message that asked, and follow-ups in a thread it has answered in need no @.",
      zh: "把应用拉进频道（`/invite @Tomrade`）并 @ 它。它在提问那条消息的话题里回复，在它回复过的话题里接着说不用再 @。" },
    { en: "Optional: for a bot that sees only messages that @mention it, remove `message.channels`, `message.groups`, `channels:history` and `groups:history` from the manifest. Follow-ups in a thread then need an @ too.",
      zh: "可选：如果只想让机器人看到 @ 它的消息，从 manifest 里去掉 `message.channels`、`message.groups`、`channels:history` 和 `groups:history`。这样在话题里接着说也要 @ 它。" }
  ],
  permissions: [...SCOPES.slice(0, -2), ...SCOPES.slice(-2).map(s => `${s} (optional)`), "connections:write (App-Level Token)"],
  manifest: { format: "yaml", text: MANIFEST },
  docsUrl: "https://api.slack.com/apps"
};

/** Slack over Socket Mode: direct messages and the agent view, @mentions and threads in channels, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({ id: "slack", title: "Slack", capabilities: CAPABILITIES, setup, open: (connectionId, io) => openSlack(connectionId, io) });
  }
});
