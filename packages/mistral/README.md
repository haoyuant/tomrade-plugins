# Mistral

Mistral AI's models from La Plateforme as a model provider in Tomrade.

- **Set up.** In Settings → Assistant (or the first-run setup), pick **Mistral AI**, paste an API key from [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) and connect. Tomrade checks the key and starts on `mistral-medium-3-5`, Mistral's model for agents and code. A key exported as `MISTRAL_API_KEY` in your shell is offered without pasting.
- **Models.** The profile's model picker lists the chat models the key can use that call tools and are not deprecated, your fine-tuned ones included. Each model is listed once, under its most specific name: `mistral-small-2603` rather than `mistral-small-latest`. The ones Mistral lists with vision read pictures.
- **Thinking.** On Medium 3.5, Large 4 and Small 4 the assistant's effort goes to Mistral's `reasoning_effort`; the other models are asked without it. What the model thinks stays out of its answer.
- **Tool calls.** Mistral takes only tool-call ids of nine letters and digits. A conversation that began on another provider has the ids of its earlier tool calls renamed to fit, the same way in every request.
- **Web search.** Mistral searches the web only in its Agents and Conversations API, not on chat/completions, so on Mistral the assistant searches with a search plugin or the search service set up in Settings.

The plugin talks to Mistral through Tomrade's own OpenAI-compatible adapter and sends only the fields Mistral's API accepts; it reaches `api.mistral.ai` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks the listing, a plain answer, tool calls after another provider's and the reasoning effort against the real API with `MISTRAL_API_KEY=… pnpm test packages/mistral`. `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for Mistral.
