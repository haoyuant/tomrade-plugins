# Tomrade 官方插件

<p>
  <a href="https://github.com/haoyuant/tomrade">Tomrade</a> ·
  <a href="https://tomrade.com/zh/">官网</a> ·
  <a href="STANDARDS.md">官方标准（英文）</a> ·
  <a href="README.md">English</a>
</p>

**[Tomrade](https://github.com/haoyuant/tomrade) 的官方 DLC。** Tomrade 是一个本地优先的工作区：你的编程 Agent 能读写需求池，撤销键留在你手里。

在 Tomrade 里一切皆插件：数据库、工具注册表、MCP 服务、助手都是。这个仓库里的是 Tomrade 自家的插件。每一个都和应用分开发布，单独构建、测试、签名、发版，修个 bug 不用等 Tomrade 出新版本。免费，Apache-2.0，没有季票。

## 安装

在 Tomrade 里打开 **设置 → 插件 → 浏览**，在 **官方插件** 里点安装。完事。

官方插件由 Tomrade 构建并签名，会自动更新（新版本要接触的东西比以前多时，会等你点头）。社区插件也都开源，但没有人审核，所以安装前 Tomrade 会先告诉你它能接触什么。番茄钟、Discord 和各个编程 Agent 是预装的：它们以前就内置在应用里，不能让老用户升级之后反而少了东西。

## 盒子里有什么

### 💬 聊天软件

*带薪蹲坑，也能派活。* 拿着手机就能和项目的助手聊：私信、@ 它，它提问时给你按钮，回复边写边出。每一个都从你自己的电脑直连，中间没有我们的服务器，也不用开公网地址。

| 插件 | 作用 |
|---|---|
| [`tomrade/discord`](packages/discord) | Discord，走 Gateway：私信、@、每张进行中的工单一个帖子或论坛帖、`/tomrade` 命令 |
| [`tomrade/slack`](packages/slack) | Slack，走 Socket Mode：私信和 Agent 视图、@ 和讨论串、`/tomrade` 命令 |
| [`tomrade/telegram`](packages/telegram) | Telegram，Bot API 长轮询：私聊、群组、论坛话题，回复以草稿形式流式显示 |
| [`tomrade/feishu`](packages/feishu) | 飞书和 Lark，走长连接：私聊、话题、卡片按钮和表单，回复流式写进卡片 |
| [`tomrade/dingtalk`](packages/dingtalk) | 钉钉，走 Stream 模式：私聊、带按钮的流式 AI 卡片，文件双向收发 |
| [`tomrade/wecom`](packages/wecom) | 企业微信智能机器人，走长连接：不需要公网地址，也不用配可信 IP |

用的是别的聊天软件？IM 适配器也只是个插件。照着这几个抄一个，或者让 Tomrade 的 Plugin Studio 替你写。

### 🧠 模型服务

*模型自己选，我们不评判。* Tomrade 本身已经支持 DeepSeek、Anthropic、OpenAI、Gemini、Kimi、OpenRouter 和任何 OpenAI 兼容接口。剩下的由这些插件补上，用的都是你手里现成的密钥或凭据；厂商自己有联网搜索的，也一并接上。

| 插件 | 作用 |
|---|---|
| [`tomrade/bedrock`](packages/bedrock) | Amazon Bedrock，包括 Claude 和 Nova，用 AWS CLI 的凭据或 Bedrock API Key |
| [`tomrade/vertex`](packages/vertex) | Google Vertex AI 上的 Gemini、Claude 和开源模型，用 gcloud 的凭据或 Vertex AI API Key |
| [`tomrade/azure-openai`](packages/azure-openai) | 你自己的 Azure OpenAI 部署，带 Azure 自己的联网搜索 |
| [`tomrade/xai`](packages/xai) | Grok，带 xAI 自己的联网搜索 |
| [`tomrade/mistral`](packages/mistral) | La Plateforme 上的 Mistral 模型 |
| [`tomrade/qwen`](packages/qwen) | 阿里云百炼上的通义千问，国内站或国际站，带千问自己的联网搜索 |
| [`tomrade/glm`](packages/glm) | 智谱 GLM，bigmodel.cn 或 Z.ai，带 GLM 自己的联网搜索 |
| [`tomrade/minimax`](packages/minimax) | MiniMax，国内或国际，带 MiniMax 自己的联网搜索 |
| [`tomrade/doubao`](packages/doubao) | 火山方舟或 BytePlus ModelArk 上的豆包，带豆包自己的联网搜索 |

### 🤖 编程 Agent

*Agent 是你的，看板是我们的。* 每一个都把你已经在用的 CLI 变成 Tomrade 的 Agent：在工单上点「开始」，工单就交给它在终端里干；它自己开的会话也会汇报回看板；它的登录还能顺便应付 Tomrade 的后台调用，不用再贴一次密钥。大多数还能通过 ACP 带着 Tomrade 的工具聊天、做工单。

| 插件 | 作用 |
|---|---|
| [`tomrade/gemini-cli`](packages/gemini-cli) | Google 的 Gemini CLI，走 ACP 或在终端里跑；登录检查知道个人 Google 账号登录已经停用 |
| [`tomrade/antigravity`](packages/antigravity) | Google 的 Antigravity CLI（`agy`），在终端里跑 |
| [`tomrade/cursor`](packages/cursor) | Cursor 的 CLI（`cursor-agent`），在终端里跑，通过 `~/.cursor/mcp.json` 连上 Tomrade |
| [`tomrade/opencode`](packages/opencode) | OpenCode，走 ACP 或在终端里跑，它配好的模型服务也借给后台用 |
| [`tomrade/hermes`](packages/hermes) | Nous Research 的 Hermes Agent，走 ACP 或在终端里跑 |
| [`tomrade/dsh`](packages/dsh) | DeepSeek Harness，走 ACP 或在终端里跑，装在它桌面应用里的那份也能找到 |
| [`tomrade/workbuddy`](packages/workbuddy) | 腾讯的 WorkBuddy，通过 CodeBuddy CLI 或应用自带的那份 |

Claude Code、Codex 和 Pi 直接内置在 Tomrade 里。

### 🍅 其他

| 插件 | 作用 |
|---|---|
| [`tomrade/pomodoro`](packages/pomodoro) | 状态栏里的番茄钟，一个老板路过只会以为是时钟的桌面浮窗，提示音想换什么都行。*专注搬砖，别忘了提肛。* |

### 🐑 herdr

[`herdr/`](herdr) 不是 Tomrade 插件，而是给 [herdr](https://herdr.dev)（编程 Agent 跑在里面的终端工作区管理器）用的插件。在终端里 Ctrl+点击 `TOM-42` 就能在 Tomrade 里打开工单，还能把一个窗格里的 Agent 认领到某张工单上。

```sh
herdr plugin install haoyuant/tomrade-plugins/herdr
```

herdr 的插件市场通过本仓库的 `herdr-plugin` topic 收录它。官方标准和下面的发布流程不适用于它。

## 开发

这个仓库对着 Tomrade 的 `main` 构建，所以 SDK 和 CLI 来自**旁边一个名叫 `tomrade-next` 的 Tomrade 检出**：

```sh
git clone https://github.com/haoyuant/tomrade.git tomrade-next
git clone https://github.com/haoyuant/tomrade-plugins.git
(cd tomrade-next && pnpm install && pnpm build:backend)
cd tomrade-plugins
pnpm install
```

```sh
pnpm test                       # 单元测试，跑在假对象上
pnpm check                      # 每个插件都过一遍官方标准
pnpm --filter <package> dev     # 改动即重新构建
pnpm --filter <package> test    # 在 Tomrade 的沙箱里跑插件的 src/test.ts 场景
pnpm --filter <package> pack    # 打出一个 .tomrade-plugin 文件
```

在 Tomrade 里打开 **设置 → 插件 → 加载文件夹…**，选中插件包的文件夹；`dist/` 一变它就重新加载。`check` 会显示安装的人将看到什么，以及插件是否达到[官方标准](STANDARDS.md)。

插件在 `tomrade-plugin.json` 里声明自己需要的 SDK（`engines.sdk`）。SDK 由 Tomrade 在运行时提供，所以插件要用 SDK 的新东西，得先把改动合进 Tomrade，再调高 `engines.sdk`。

### 这里的每个插件都达标

[STANDARDS.md](STANDARDS.md) 就是那条线：id 用 `tomrade/<name>`，OSI 认可的许可证并附 LICENSE 文件，README、图标和更新日志条目齐全，所有文案中英文都有，权限不多要（要得宽的每一项都写明理由），沙箱里的场景测试要通过。CI 在每个 PR 上跑 `pnpm check`，不达标的发不了版。标准里也写了怎么发版。

### 想写自己的插件？

用不着这个仓库。从 npm 装 CLI，生成一个开箱就能构建、测试、加载的脚手架：

```sh
npx -p @tomradex/plugin-cli tomrade-plugin init my-plugin --id you/my-plugin
```

插件契约见 Tomrade 的 [`docs/plugin-api.md`](https://github.com/haoyuant/tomrade/blob/main/docs/plugin-api.md)（英文）。懒得写代码？在 Tomrade 的 Plugin Studio 里描述你要的插件，让 Agent 来写、来测。插件归你，用什么许可证都行，商业许可证也可以。

## 许可证

这里的每个插件都和 Tomrade 一样采用 [Apache-2.0](LICENSE)。许可证不授予 Tomrade 名称和 logo 的使用权。
