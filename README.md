# Tomrade plugins

Tomrade's official plugins. Each one ships apart from the app: it is built,
tested, signed and released on its own, so a change reaches people without a
new app release. Tomrade lists them under **Official** in Settings → Plugins →
Browse and installs them from there.

| Package | Plugin | What it does |
|---|---|---|
| `packages/feishu` | `tomrade/feishu` | Feishu and Lark IM over the long connection |

Every plugin here meets [the official standard](STANDARDS.md). The standard
also says how a version is released.

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
