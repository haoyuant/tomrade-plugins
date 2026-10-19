# xAI Grok

Grok models from xAI as a model provider in Tomrade.

- **Set up.** In Settings → Assistant (or the first-run setup), pick **xAI Grok**, paste an xAI API key (`xai-…`, made at [console.x.ai](https://console.x.ai/team/default/api-keys)) and connect. Tomrade checks the key and starts on `grok-4.7`. A key exported as `XAI_API_KEY` in your shell is offered without pasting.
- **Models.** The profile's model picker lists the chat models the key can use, the numbered Groks first (`GET /v1/language-models`, which also says which models read pictures; `GET /v1/models` where an address has no such listing). Grok 4.x reads pictures. The multi-agent model is left out: it takes no function tools, so it cannot run the assistant's tools.
- **Web search.** Grok 4.x and later search the web themselves when the assistant needs it, so no search service is needed for them. xAI's search runs only on its Responses API (`web_search`), where a searching request goes; Live Search on chat/completions is gone. If xAI refuses a search, the assistant searches another way.
- **Effort.** The assistant's effort is Grok's reasoning effort (its least, `low`, for minimal), on chat/completions and on the Responses API alike; the non-reasoning models take none.

The plugin talks to xAI through Tomrade's own OpenAI-compatible adapter; it reaches `x.ai` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks the listing, chat/completions and the search against the real xAI API with `XAI_API_KEY=… pnpm test packages/xai` (`XAI_MODEL` for another model). `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for xAI.
