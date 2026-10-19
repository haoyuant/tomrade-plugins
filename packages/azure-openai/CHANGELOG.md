# Changelog

## 0.1.0

- Azure OpenAI as a model provider: a resource name or endpoint completed to the resource's v1 API, the key sent in `api-key` and checked by listing the models the resource can deploy, deployments by name, Azure's own web search on the Responses API, and `max_completion_tokens` in place of `max_tokens`. With `AZURE_OPENAI_ENDPOINT` exported, the setup starts on that resource and offers `AZURE_OPENAI_API_KEY`. Needs Tomrade with plugin SDK 0.2.16.
