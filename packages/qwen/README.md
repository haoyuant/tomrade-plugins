# Qwen

Qwen models from Alibaba Cloud Model Studio (百炼 Bailian) as a model provider in Tomrade.

- **Set up.** In Settings → Assistant (or the first-run setup), pick **通义千问 Qwen** for a mainland China account or **Qwen (International)** for one in Singapore, paste the DashScope API key and connect. Tomrade checks the key and starts on `qwen-plus`. A key exported as `DASHSCOPE_API_KEY` in your shell is offered without pasting. A key works only in the region it was made in.
- **Workspace endpoints.** Model Studio's newer addresses carry the workspace, `https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`. Put one in the profile's address to use it; the older `dashscope.aliyuncs.com` and `dashscope-intl.aliyuncs.com` addresses are the presets.
- **Models.** The profile's model picker lists the chat models the key can use, the other vendors' models Model Studio serves on the same key included. VL, Omni and QVQ models read pictures.
- **Web search.** Qwen's commercial models (max, plus, flash, turbo and the Qwen3.x ones) search the web themselves when the assistant needs it (`enable_search`), so no search service is needed for them.
- **Thinking.** On the hybrid Qwen3.x models the assistant's effort switches thinking: off for quick work, on otherwise (`enable_thinking`).

The plugin talks to Model Studio through Tomrade's own OpenAI-compatible adapter; it reaches `aliyuncs.com` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks Qwen's own fields against the real Model Studio with `DASHSCOPE_API_KEY=… pnpm test packages/qwen` (`DASHSCOPE_BASE_URL` for another address). `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for Model Studio.
