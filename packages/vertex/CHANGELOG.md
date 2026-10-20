# Changelog

## 0.1.0

- Google Vertex AI as a model provider:
  - gcloud's credentials (Application Default Credentials, else gcloud's own sign-in) or a Vertex AI API key, and the project you work in;
  - Gemini on Vertex's own streamGenerateContent: tool calls, pictures, PDFs, sound and video, the effort as Gemini 3's thinking level, its thought signatures kept through a tool loop, cached tokens counted;
  - Google Search grounding on a request without tools, its pages listed after the answer;
  - Claude on Vertex's streamRawPredict: tool calls, pictures and PDFs, its adaptive thinking and effort, its signed thinking kept through a tool loop, a cached system prompt, and Claude's own web search;
  - the open models Vertex serves (gpt-oss, DeepSeek, Qwen, Llama…) on Tomrade's OpenAI-compatible adapter;
  - Google's Gemini text models, the Claude models and the open models in the picker.
- Needs Tomrade with plugin SDK 0.2.16.
