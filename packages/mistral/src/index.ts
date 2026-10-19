import { definePlugin } from "@tomradex/plugin-sdk";
import { MISTRAL, PRESETS, listing, media, shape } from "./mistral.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "Mistral AI", zh: "Mistral AI" },
      baseURL: { default: MISTRAL },
      presets: PRESETS,
      list: listing,
      capabilities: media,
      build: (profile) =>
        ctx.models.compatible({
          baseURL: profile.baseURL || MISTRAL,
          apiKey: profile.apiKey,
          model: profile.model,
          inputModalities: profile.inputModalities,
          // no output media: chat/completions answers in text, so the adapter never sends `modalities` or `audio`
          body: (json) => shape(profile.model, json)
        })
    });
  }
});
