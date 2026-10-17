# The official standard

Every plugin in this repository is one of Tomrade's own: Tomrade signs it,
lists it under **Official** in Settings → Plugins → Browse, and installs and
updates it for people without asking them to review it. That trust is earned
here. `tomrade-plugin check --official` (`pnpm check`) holds each plugin to the
rules below. CI runs it on every pull request, and a release refuses anything
that falls short.

## The rules

**Identity**

- The id is `tomrade/<name>`, and the plugin lives in `packages/<name>`.
- `engines.sdk` includes the SDK of the Tomrade it is released against.

**Open source**

- The license is an OSI-approved SPDX identifier. Plugins here use Apache-2.0.
- A `LICENSE` file ships in the plugin's folder.
- `repository` is this repository.

**Says what it is**

- `description` is filled in; Tomrade shows it beside the title.
- `README.md` says what the plugin does and how to set it up.
- `icon` names an SVG or PNG in the plugin's folder.
- `CHANGELOG.md` has an entry for the version being released.

**Both languages**

Every text a person reads is written as `{ en, zh }`, with both halves
filled in. The check flags any object that has one half without the other. Plain
strings it cannot see, so review keeps an eye on those.

**Reaches no further than it must**

- `permissions.network` lists the hosts the plugin talks to.
- `"*"` (any host), `fs: "any"` and `exec: true` each need a sentence in
  `permissions.why` (`network`, `fs`, `exec`) that a person installing the
  plugin can judge.
- Tomrade shows what a plugin can reach before it is installed, and an update
  that reaches further never installs by itself.

**Tested**

- Unit tests in `tests/` run against fakes (`pnpm test`).
- The `src/test.ts` scenario passes in Tomrade's sandbox. The official check
  runs it.

## Releasing

1. Raise `version` in `tomrade-plugin.json` and add the CHANGELOG entry, in
   the pull request that changes the plugin.
2. Once it is merged, tag `main`: `git tag <name>@<version> && git push origin <name>@<version>`.
3. The Release workflow checks the plugin and signs that exact build with
   Tomrade's key. It uploads the package and the new `catalog.json` to the
   `catalog` release, and every Tomrade picks it up at its next check.

A version is released once. Releasing the same build again changes nothing,
and a different build under a released version is refused, so the version
must be raised instead.

To switch a released version off on every machine, add it to
`catalog/revoked.json` (`[{ "id": "tomrade/<name>", "versions": "<range>", "reason": "…" }]`).
Merge that change, then run the Release workflow by hand for that plugin.

## Repository secrets

- `TOMRADE_SIGNING_KEY`: Tomrade's signing key (PKCS#8 PEM, key id
  `124a919478f3571d`), the one `apps/desktop/src/trust.ts` trusts.
- `TOMRADE_REPO_TOKEN`: a token that can read `haoyuant/tomrade`. CI builds
  the plugin SDK and CLI from it.
