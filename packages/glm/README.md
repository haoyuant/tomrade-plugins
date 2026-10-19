# Zhipu GLM

Zhipu's GLM models as a model provider in Tomrade, on 智谱开放平台 (bigmodel.cn, mainland China) or Z.ai (international).

- **Set up.** In Settings → Assistant (or the first-run setup), pick **智谱 GLM** for a bigmodel.cn account or **Z.ai** for a Z.ai one, paste the API key (`{id}.{secret}`) and connect. Tomrade checks the key and starts on `glm-5.3`. A key exported as `ZHIPUAI_API_KEY` (bigmodel.cn) or `ZAI_API_KEY` (Z.ai) in your shell is offered without pasting. The two platforms have separate accounts: a key works only on the one it was made on.
- **GLM Coding Plan.** Not offered. A Coding Plan key is for the coding tools Zhipu lists, on its own endpoint, not for other apps; use a standard API key, billed to the account's balance.
- **Models.** The profile's model picker lists the chat models the endpoint lists, or, where it lists none, the ones the platform serves: GLM-5.3, 5.3-Flash and FlashX, 5.2, 5.1, 5, 4.7 and 4.6, plus GLM-5-Turbo, GLM-5V-Turbo, GLM-4.6V and the GLM-4.7 Flash models on bigmodel.cn. GLM-5.3-Flash, FlashX and the V models read pictures.
- **Web search.** GLM's text models search the web themselves when the assistant needs it, with GLM's `web_search` tool (`search_pro` on bigmodel.cn, `search-prime` on Z.ai; each search is billed by the platform), so no search service is needed for them. The vision models do not search.
- **Thinking.** GLM-5.2 and later think at the assistant's effort (`reasoning_effort`: `low` for quick work, `high` otherwise); GLM-5.3 always thinks. On GLM-4.5 to GLM-5.1 the effort switches thinking: off for quick work, on otherwise (`thinking`).

The plugin talks to GLM through Tomrade's own OpenAI-compatible adapter; it reaches `open.bigmodel.cn` and `api.z.ai` only.

`tests/` runs the provider against a fake host, and `tests/live.test.ts` checks GLM's own fields against the real platforms with `ZHIPUAI_API_KEY=… pnpm test packages/glm` (bigmodel.cn) or `ZAI_API_KEY=…` (Z.ai). `src/test.ts` runs the provider in Tomrade's sandbox against a stand-in for bigmodel.cn.
