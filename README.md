# Tomrade plugins

Tomrade's official plugins. Each one ships apart from the app: it is built,
tested, signed and released on its own, so a change reaches people without a
new app release. Tomrade lists them under **Official** in Settings → Plugins →
Browse and installs them from there.

| Package | Plugin | What it does |
|---|---|---|
| `packages/feishu` | `tomrade/feishu` | Feishu and Lark IM over the long connection |
| `packages/telegram` | `tomrade/telegram` | Telegram IM over Bot API long polling |
| `packages/slack` | `tomrade/slack` | Slack IM over Socket Mode |
| `packages/dingtalk` | `tomrade/dingtalk` | DingTalk IM over Stream mode |
| `packages/discord` | `tomrade/discord` | Discord IM over the Gateway |
| `packages/wecom` | `tomrade/wecom` | WeCom (企业微信) intelligent bot over the long connection |
| `packages/qwen` | `tomrade/qwen` | Qwen models from Alibaba Cloud Model Studio as a model provider, with Qwen's own web search |
| `packages/bedrock` | `tomrade/bedrock` | Models on Amazon Bedrock, Claude included, as a model provider, with the AWS CLI's credentials or a Bedrock API key |
| `packages/xai` | `tomrade/xai` | Grok models from xAI as a model provider, searching the web with xAI's own search |
| `packages/vertex` | `tomrade/vertex` | Gemini and the open models on Google Vertex AI as a model provider, with the credentials gcloud holds or a Vertex AI API key |
| `packages/glm` | `tomrade/glm` | Zhipu GLM models (bigmodel.cn and Z.ai) as a model provider, with GLM's own web search |
| `packages/minimax` | `tomrade/minimax` | MiniMax models, mainland and international, as a model provider, with MiniMax's own web search |
| `packages/azure-openai` | `tomrade/azure-openai` | Azure OpenAI deployments as a model provider, with Azure's own web search |
| `packages/mistral` | `tomrade/mistral` | Mistral models as a model provider |
| `packages/doubao` | `tomrade/doubao` | Doubao on Volcengine Ark and BytePlus ModelArk as a model provider, with Doubao's own web search |
| `packages/pomodoro` | `tomrade/pomodoro` | Focus and break timer in the status bar, with a desktop widget and alerts; installed once on every machine |

Every plugin here meets [the official standard](STANDARDS.md). The standard
also says how a version is released.

`herdr/` is not a Tomrade plugin but a plugin for [herdr](https://herdr.dev),
the terminal workspace manager coding agents run in: it opens and claims
Tomrade tickets from the terminal. herdr's marketplace lists it from this
repository's `herdr-plugin` topic; `herdr plugin install haoyuant/tomrade-plugins/herdr`
installs it. The official standard and the release workflow do not apply to it.

## Develop

The plugin SDK and CLI are not published yet; they come from a Tomrade
checkout next to this one (`../tomrade-next`), built once with
`pnpm build:backend` there.

```sh
pnpm install
pnpm test                                   # unit tests against fakes
pnpm check                                  # the official standard, for every plugin
pnpm --filter <package> dev                 # rebuild on every change
```

In Tomrade, Settings → Plugins → Load folder… and pick the package folder;
it reloads whenever `dist/` changes. `pnpm --filter <package> test` runs the
plugin's `src/test.ts` scenario in Tomrade's sandbox, `check` shows what an
installer will see and whether it meets the official standard, and `pack` makes a
`.tomrade-plugin` file.

The SDK contract a plugin needs is in its `tomrade-plugin.json`
(`engines.sdk`). A plugin that needs something new from the SDK lands that
change in Tomrade first.
