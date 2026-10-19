import { definePlugin } from "@tomradex/plugin-sdk";
import { MAINLAND, PRESETS, known, media, searches, shape, usable } from "./glm.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "GLM (Zhipu AI)", zh: "GLM（智谱）" },
      baseURL: { default: MAINLAND },
      presets: PRESETS,
      list: async (endpoint, signal) => {
        const baseURL = endpoint.baseURL || MAINLAND;
        const listed = await ctx.models.listCompatible({ baseURL, apiKey: endpoint.apiKey }, signal);
        // GLM documents no listing; a bad key is still a 401 there, so only a good one gets the known models
        return listed.ok && !listed.models ? { ...listed, models: known(baseURL) } : listed;
      },
      usable,
      capabilities: media,
      build: (profile) => {
        const baseURL = profile.baseURL || MAINLAND;
        return ctx.models.compatible({
          baseURL,
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          outputModalities: profile.outputModalities,
          ...(searches(profile.model) ? { webSearch: "chat" as const } : {}),
          body: (json, request) => shape(profile.model, baseURL, json, request)
        });
      }
    });
  }
});
