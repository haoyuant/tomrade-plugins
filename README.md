# Tomrade plugins

Plugins that ship apart from the Tomrade app: each one is built, tested and
installed on its own, so a change reaches people without a new app release.

| Package | Plugin | What it does |
|---|---|---|
| `packages/im-feishu` | `tomrade/feishu` | Feishu and Lark IM over the long connection |
| `packages/dingtalk` | `tomrade/dingtalk` | DingTalk IM over Stream mode |

## Develop

The plugin SDK and CLI are not published yet; they come from a Tomrade
checkout next to this one (`../tomrade-next`), built once with
`pnpm build:backend` there.

```sh
pnpm install
pnpm test                                   # unit tests against fakes
pnpm --filter <package> dev                 # rebuild on every change
```

In Tomrade, Settings → Plugins → Load folder… and pick the package folder;
it reloads whenever `dist/` changes. `pnpm --filter <package> test` runs the
plugin's `src/test.ts` scenario in Tomrade's sandbox, `check` shows what an
installer will see, and `pack` makes a `.tomrade-plugin` file.

The SDK contract a plugin needs is in its `tomrade-plugin.json`
(`engines.sdk`). A plugin that needs something new from the SDK lands that
change in Tomrade first.
