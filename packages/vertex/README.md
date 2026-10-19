# Google Vertex AI

Gemini and the open models Google serves on Vertex AI as a model provider in Tomrade: Gemini 4 and 3.x, and the open models of Vertex's Model as a Service (gpt-oss, DeepSeek, Qwen, Kimi, GLM, MiniMax, Llama, Gemma…).

- **Set up.** In Settings → Assistant (or the first-run setup):
  - **Google Vertex AI** uses the credentials already on this computer: Application Default Credentials (`gcloud auth application-default login`), else gcloud's own sign-in (`gcloud auth login`, a service account included). There is no key to paste.
  - **Google Vertex AI (API key)** takes a Vertex AI API key, an express-mode one included, from the [API keys page](https://console.cloud.google.com/agent-platform/studio/settings/api-keys). A key exported as `GOOGLE_API_KEY` is offered without pasting. A key reaches Gemini only.
  - Tomrade checks access and starts on Gemini 3.8 Flash.
- **Project and location.** Profiles talk to the global endpoint of the project from `GOOGLE_CLOUD_PROJECT`, `CLOUDSDK_CORE_PROJECT`, `gcloud config get-value project` or the ADC file's quota project. To use another, type its project id in the profile's address, `projects/{project}/locations/{location}` for a region, or a full address. With your own ADC credentials, use is billed to the ADC file's quota project, as Google's client libraries do.
- **Models.** The picker lists Google's Gemini models that write text, newest first, then the open models. Gemini reads pictures, PDFs, sound and video.
- **Thinking.** The assistant's effort sets Gemini 3's thinking level. Gemini's thought signatures go back with the tool calls they led to, as Gemini 3 requires in a tool loop.
- **Web search.** Gemini grounds an answer in Google Search when a request without tools asks for it, and lists the pages after the answer. Vertex does not take Google Search beside function tools, and the assistant offers tools on every step, so there Tomrade's web search plugins cover it.
- **Open models.** These go through Vertex's OpenAI-compatible endpoint on Tomrade's own adapter, and need Google Cloud credentials: an API key cannot reach them.
- **Not yet.** Claude on Vertex AI (`:streamRawPredict`) is not supported yet; the Anthropic and Amazon Bedrock providers serve Claude.

The plugin talks to Gemini through Vertex's own `streamGenerateContent`, and to the open models through Tomrade's OpenAI-compatible adapter. It reaches `googleapis.com` only (Vertex AI, and Google's sign-in to exchange the ADC refresh token). It reads no file but the ADC one, and runs gcloud for nothing but `gcloud config get-value project` and `gcloud config config-helper`.

`tests/` runs the provider against a fake host and stand-ins for Google: both ways to a token, the address, the generateContent mapping, the stream reader, retries, the listing and the open models' headers. `tests/live.test.ts` runs a tool loop and a Google Search on the real Vertex AI with `VERTEX_LIVE=1 pnpm test packages/vertex`; Google bills it. `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for Vertex AI.
