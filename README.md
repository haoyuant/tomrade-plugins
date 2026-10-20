# Tomrade plugins

<p>
  <a href="https://github.com/haoyuant/tomrade">Tomrade</a> ·
  <a href="https://tomrade.com">Website</a> ·
  <a href="STANDARDS.md">The official standard</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

**The official DLC for [Tomrade](https://github.com/haoyuant/tomrade)**, the local-first workspace where your coding agents read and write the backlog and you keep the undo button.

In Tomrade, everything is a plugin: the database, the tool registry, the MCP server, the assistant. The ones in this repository are Tomrade's own. Each ships apart from the app, built, tested, signed and released on its own, so a fix reaches you without waiting for a new Tomrade. Free, Apache-2.0, no season pass.

## Install one

In Tomrade: **Settings → Plugins → Browse**, under **Official plugins**. Click Install. That's it.

Official plugins are built and signed by Tomrade, and update on their own (an update that wants to reach further than before waits for you). Community plugins are open source too, but nobody reviews them, so Tomrade shows what one can reach before you install it. Pomodoro, Discord and the coding agents come pre-installed, because they used to live inside the app and nobody should lose what they had.

## What's in the box

### 💬 Chat apps

*Toilet-break productivity unlocked.* Talk to a project's assistant from your phone: direct messages and @mentions, buttons for its questions, replies that stream in. Every one connects from your own computer, so there's no server of ours in between and no public address to open.

| Plugin | What it does |
|---|---|
| [`tomrade/discord`](packages/discord) | Discord over the Gateway: DMs, @mentions, a thread or forum post per ticket being worked, the `/tomrade` command |
| [`tomrade/slack`](packages/slack) | Slack over Socket Mode: DMs and the agent view, @mentions and threads, the `/tomrade` command |
| [`tomrade/telegram`](packages/telegram) | Telegram over Bot API long polling: direct chats, groups, forum topics, replies that stream as drafts |
| [`tomrade/feishu`](packages/feishu) | Feishu and Lark over the long connection: chats, topics, card buttons and forms, replies that stream into a card |
| [`tomrade/dingtalk`](packages/dingtalk) | DingTalk over Stream mode: chats, AI cards that stream and carry buttons, files both ways |
| [`tomrade/wecom`](packages/wecom) | WeCom (企业微信) intelligent bot over the long connection: no public address or trusted IP needed |

Using something else? An IM adapter is just a plugin. Copy one of these, or ask Tomrade's Plugin Studio to write yours.

### 🧠 Model providers

*Bring your own model. We don't judge.* Tomrade already speaks DeepSeek, Anthropic, OpenAI, Gemini, Kimi, OpenRouter and any OpenAI-compatible endpoint. These add the rest, each with the keys or credentials you already have, and web search from the provider itself where it has one.

| Plugin | What it does |
|---|---|
| [`tomrade/bedrock`](packages/bedrock) | Amazon Bedrock, Claude and Nova included, with the AWS CLI's credentials or a Bedrock API key |
| [`tomrade/vertex`](packages/vertex) | Gemini, Claude and open models on Google Vertex AI, with the credentials gcloud holds or a Vertex AI API key |
| [`tomrade/azure-openai`](packages/azure-openai) | Your Azure OpenAI deployments, with Azure's own web search |
| [`tomrade/xai`](packages/xai) | Grok, with xAI's own web search |
| [`tomrade/mistral`](packages/mistral) | Mistral models from La Plateforme |
| [`tomrade/qwen`](packages/qwen) | Qwen from Alibaba Cloud Model Studio (Bailian), mainland or international, with Qwen's own web search |
| [`tomrade/glm`](packages/glm) | Zhipu GLM on bigmodel.cn or Z.ai, with GLM's own web search |
| [`tomrade/minimax`](packages/minimax) | MiniMax, mainland or international, with MiniMax's own web search |
| [`tomrade/doubao`](packages/doubao) | Doubao on Volcengine Ark (火山方舟) or BytePlus ModelArk, with Doubao's own web search |

### 🤖 Coding agents

*Your agents, our board.* Each one turns a CLI you already use into a Tomrade agent: press Start on a ticket and it goes to that agent in a terminal, its own sessions report back to the board, and its sign-in answers Tomrade's background calls, so there's no second key to paste. Most also hold conversations and work tickets over ACP with Tomrade's tools.

| Plugin | What it does |
|---|---|
| [`tomrade/gemini-cli`](packages/gemini-cli) | Google's Gemini CLI, over ACP or in a terminal, with a sign-in check that knows personal Google sign-in ended |
| [`tomrade/antigravity`](packages/antigravity) | Google's Antigravity CLI (`agy`), in a terminal |
| [`tomrade/cursor`](packages/cursor) | Cursor's CLI (`cursor-agent`), in a terminal, connected through `~/.cursor/mcp.json` |
| [`tomrade/opencode`](packages/opencode) | OpenCode, over ACP or in a terminal, with its providers lent to the worker |
| [`tomrade/hermes`](packages/hermes) | Hermes Agent from Nous Research, over ACP or in a terminal |
| [`tomrade/dsh`](packages/dsh) | DeepSeek Harness, over ACP or in a terminal, found inside its desktop app too |
| [`tomrade/workbuddy`](packages/workbuddy) | WorkBuddy from Tencent, through its CodeBuddy CLI or the app's own copy |

Claude Code, Codex and Pi are built into Tomrade itself.

### 🍅 Everything else

| Plugin | What it does |
|---|---|
| [`tomrade/pomodoro`](packages/pomodoro) | A focus timer in the status bar, a desktop widget your boss will mistake for a clock, an alert that can be any sound you like. *Lock in. Don't forget your Kegels.* |

### 🐑 herdr

[`herdr/`](herdr) isn't a Tomrade plugin: it's a plugin for [herdr](https://herdr.dev), the terminal workspace manager coding agents run in. It opens Tomrade tickets from the terminal (Ctrl-click `TOM-42`) and claims a pane's agent to a ticket.

```sh
herdr plugin install haoyuant/tomrade-plugins/herdr
```

herdr's marketplace lists it through this repository's `herdr-plugin` topic. The official standard and the release workflow below don't apply to it.

## Develop

This repository builds against Tomrade's `main`, so the SDK and CLI come from a Tomrade checkout **next to this one, named `tomrade-next`**:

```sh
git clone https://github.com/haoyuant/tomrade.git tomrade-next
git clone https://github.com/haoyuant/tomrade-plugins.git
(cd tomrade-next && pnpm install && pnpm build:backend)
cd tomrade-plugins
pnpm install
```

```sh
pnpm test                       # unit tests against fakes
pnpm check                      # the official standard, for every plugin
pnpm --filter <package> dev     # rebuild on every change
pnpm --filter <package> test    # the plugin's src/test.ts scenario, in Tomrade's sandbox
pnpm --filter <package> pack    # a .tomrade-plugin file
```

In Tomrade, **Settings → Plugins → Load folder…** and pick the package folder; it reloads whenever `dist/` changes. `check` shows what an installer will see and whether the plugin meets [the official standard](STANDARDS.md).

A plugin states the SDK it needs in `tomrade-plugin.json` (`engines.sdk`). Tomrade provides the SDK at run time, so a plugin that needs something new from it lands that change in Tomrade first, then raises `engines.sdk`.

### Every plugin here meets the standard

[STANDARDS.md](STANDARDS.md) is the bar: `tomrade/<name>` ids, an OSI license and a LICENSE file, a README, an icon and a changelog entry, every text in both English and Chinese, permissions no wider than needed (and a reason for each wide one), and a scenario test that passes in the sandbox. CI runs `pnpm check` on every pull request, and a release refuses anything that falls short. The standard also says how a version is released.

### Writing your own plugin?

You don't need this repository. Install the CLI from npm and start from a scaffold that already builds, tests and loads:

```sh
npx -p @tomradex/plugin-cli tomrade-plugin init my-plugin --id you/my-plugin
```

The contract is in Tomrade's [`docs/plugin-api.md`](https://github.com/haoyuant/tomrade/blob/main/docs/plugin-api.md). Or skip the typing: describe the plugin to Tomrade's Plugin Studio and let an agent write and test it. Your plugin, your license, commercial ones included.

## License

Every plugin here is [Apache-2.0](LICENSE), like Tomrade itself. The license doesn't grant the Tomrade name or logo.
