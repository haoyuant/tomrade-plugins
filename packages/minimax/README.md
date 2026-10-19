# MiniMax

MiniMax models as a model provider in Tomrade, from the mainland China platform (platform.minimax.cn) or the international one (platform.minimax.io).

- **Set up.** In Settings → Assistant (or the first-run setup), pick **MiniMax 开放平台** for a mainland China account or **MiniMax (International)** for an international one, paste the API key and connect. Tomrade checks the key and starts on `MiniMax-M3.1-Flash`. A key exported as `MINIMAX_API_KEY` in your shell is offered without pasting. A key works only on the platform it was made on.
- **Keys.** A pay-as-you-go key comes from the platform's API keys page (`/user-center/basic-information/interface-key`); an M Plan subscription key (`sk-cp-…`, from `/console/plan`) works on the same address and spends the plan's usage instead. MiniMax allows M Plan keys in third-party tools.
- **Models.** The profile's model picker lists the chat models the key can use: `MiniMax-M3.1-Flash` and, on pay-as-you-go, `MiniMax-M3`. Both read pictures. The retired M2.x models are left out.
- **Thinking.** M3.x thinks before it answers. The thinking is kept apart (`reasoning_split`), so it never shows up in the answer. On M3.1-Flash the assistant's effort sets its depth (`reasoning_effort`; minimal asks for low, since it cannot stop thinking); MiniMax-M3 has no depth to set.
- **Web search.** M3.x searches the web itself when the assistant needs it, with MiniMax's `web_search` server tool on its Responses API (Beta; MiniMax bills it per request), so no search service is needed. Should MiniMax turn the search down, the assistant searches with Tomrade's web search plugin for the rest of the turn.

The plugin talks to MiniMax through Tomrade's own OpenAI-compatible adapter; it reaches `api.minimax.cn` and `api.minimax.io` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks MiniMax's own fields and its Responses search against the real API with `MINIMAX_API_KEY=… pnpm test packages/minimax` (`MINIMAX_BASE_URL=https://api.minimax.io/v1` for an international key). `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for MiniMax.
