# Tomrade for herdr

A [herdr](https://herdr.dev) plugin that brings the Tomrade backlog to the terminal. It talks to the Tomrade already on this machine; it needs no account and no network of its own.

- **Open a ticket.** Ctrl-click a `tomrade://item/…` link, or a ticket key such as `TOM-42` in a repository connected to Tomrade, and the ticket opens in Tomrade. The key is looked up through the repository's `.mcp.json`, which "Connect repository to coding agents" writes.
- **Claim this pane to a ticket.** From a pane with an agent in it, run the action: a popup asks for the key, and the agent is told to call `claim_ticket` first — through the repository's `tomrade` MCP server — and then start on the ticket. Tomrade follows the session from there as it follows any terminal session. Ctrl-click a key with the action bound to it, and the popup is skipped.
- **New worktree.** When herdr makes a worktree, a toast reminds you that an agent in it can take a ticket.

Install:

```sh
herdr plugin install haoyuant/tomrade-plugins/herdr
```

For a checkout of this repository, `herdr plugin link /path/to/tomrade-plugins/herdr`. `herdr plugin action list` shows the two actions; bind one to a key in herdr's config with `[[keys.command]]`.

Scripts are POSIX `sh` and use only `sed`, `grep`, the herdr CLI (`HERDR_BIN_PATH`) and the system's `open` / `xdg-open`. Nothing is written outside herdr's state directory for the plugin.

The other half lives in Tomrade itself: Settings → Code link → Terminal app set to `herdr` runs a ticket in a herdr workspace, follows the pane's status, resumes it connected after a herdr restart, and continues it in the same pane.
