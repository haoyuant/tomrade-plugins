import { definePlugin } from "@tomradex/plugin-sdk";
import { MAINLAND, PRESETS, answer, known, media, searches, shape, usable } from "./doubao.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "Doubao (Volcengine Ark)", zh: "豆包（火山方舟）" },
      baseURL: { default: MAINLAND },
      presets: PRESETS,
      list: async (endpoint, signal) => {
        const baseURL = endpoint.baseURL || MAINLAND;
        const listed = await ctx.models.listCompatible({ baseURL, apiKey: endpoint.apiKey }, signal);
        // an address without a listing still checks the key (401), and then offers the models it is known to serve
        return listed.ok && !listed.models ? { ...listed, models: known(baseURL) } : listed;
      },
      usable,
      capabilities: media,
      build: (profile) =>
        ctx.models.compatible({
          baseURL: profile.baseURL || MAINLAND,
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          outputModalities: profile.outputModalities,
          ...(searches(profile.model) ? { webSearch: "responses" as const } : {}),
          body: (json) => shape(profile.model, json),
          responses: (json) => answer(json)
        })
    });
  }
});
