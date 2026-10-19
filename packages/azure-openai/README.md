# Azure OpenAI

Azure OpenAI (Microsoft Foundry) as a model provider in Tomrade: the models deployed on your own Azure resource.

- **Set up.** In Settings → Assistant, add an **Azure OpenAI** profile. Put the resource's endpoint in its address (Azure portal → the resource → Keys and Endpoint, or the resource's page in [Foundry](https://ai.azure.com)), `https://{resource}.openai.azure.com` or just the resource name, and paste one of its keys. Tomrade completes the address to the resource's v1 API, `https://{resource}.openai.azure.com/openai/v1`; `*.services.ai.azure.com` and `*.cognitiveservices.azure.com` resources keep their own host. With `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` exported in your shell, the setup starts on that resource and offers the key without pasting.
- **Models are deployments.** The model is the name of a deployment on the resource. Azure lists no deployments for a key, so the picker lists the models the resource can deploy, which match deployments named after their model (the portal's default). For a deployment with its own name, pick **Other** and type it.
- **Web search.** GPT-4 and later models search the web themselves when the assistant needs it, through Azure's Responses API (`web_search`). It runs on Grounding with Bing: Azure bills the searches, the data leaves your resource's compliance and geo boundary, and a subscription admin can switch it off. A model or subscription without it refuses, and Tomrade searches another way.

The plugin talks to Azure through Tomrade's own OpenAI-compatible adapter, with the key in the `api-key` header and `max_completion_tokens` in place of `max_tokens`. It reaches `openai.azure.com`, `services.ai.azure.com` and `cognitiveservices.azure.com` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks it against a real resource with `AZURE_OPENAI_ENDPOINT=… AZURE_OPENAI_API_KEY=… pnpm test packages/azure-openai` (`AZURE_OPENAI_DEPLOYMENT=…` adds a chat and a web search on that deployment). `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for Azure.
