import { definePlugin } from "@tomradex/plugin-sdk";
import { NO_ADDRESS, PROVIDER, address, auth, presets, shape, usable } from "./azure.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    // each resource has its own address: the one exported for Azure's SDKs, if any, is where profiles start
    const exported = address(process.env.AZURE_OPENAI_ENDPOINT);
    await ctx.models.registerProvider({
      id: PROVIDER,
      title: { en: "Azure OpenAI", zh: "Azure OpenAI" },
      baseURL: { default: exported },
      presets: presets(exported),
      list: (endpoint, signal) => {
        const baseURL = address(endpoint.baseURL || exported);
        if (!baseURL) return { ok: false, detail: NO_ADDRESS };
        return ctx.models.listCompatible({ baseURL, apiKey: endpoint.apiKey, headers: auth(endpoint.apiKey) }, signal);
      },
      usable,
      build: (profile) =>
        ctx.models.compatible({
          baseURL: address(profile.baseURL || exported),
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          outputModalities: profile.outputModalities,
          // GPT-4 and later search through Bing on the Responses API; a deployment or subscription without it refuses
          webSearch: "responses",
          body: (json) => shape(json),
          headers: () => auth(profile.apiKey)
        })
    });
  }
});
