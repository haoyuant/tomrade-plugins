import { definePlugin } from "@tomradex/plugin-sdk";
import { API, PRESETS, answer, languageModels, media, searches, shape, usable } from "./xai.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "xAI (Grok)", zh: "xAI（Grok）" },
      baseURL: { default: API },
      presets: PRESETS,
      list: async (endpoint, signal) => {
        const baseURL = endpoint.baseURL || API;
        return (await languageModels(baseURL, endpoint.apiKey, signal)) ?? ctx.models.listCompatible({ baseURL, apiKey: endpoint.apiKey }, signal);
      },
      usable,
      capabilities: media,
      build: (profile) =>
        ctx.models.compatible({
          baseURL: profile.baseURL || API,
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          outputModalities: profile.outputModalities,
          ...(searches(profile.model) ? { webSearch: "responses" as const } : {}),
          body: (json) => shape(profile.model, json),
          responses: (json) => answer(profile.model, json)
        })
    });
  }
});
