import { definePlugin } from "@tomradex/plugin-sdk";
import { MAINLAND, PRESETS, media, searches, shape, usable } from "./minimax.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "MiniMax", zh: "MiniMax" },
      baseURL: { default: MAINLAND },
      presets: PRESETS,
      list: (endpoint, signal) => ctx.models.listCompatible({ baseURL: endpoint.baseURL || MAINLAND, apiKey: endpoint.apiKey }, signal),
      usable,
      capabilities: media,
      build: (profile) =>
        ctx.models.compatible({
          baseURL: profile.baseURL || MAINLAND,
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          outputModalities: profile.outputModalities,
          // a searching request goes to {base}/responses with the web_search tool; MiniMax refusing it lets the app search another way
          ...(searches(profile.model) ? { webSearch: "responses" as const } : {}),
          body: (json) => shape(profile.model, json)
        })
    });
  }
});
