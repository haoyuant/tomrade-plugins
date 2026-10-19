import { definePlugin } from "@tomradex/plugin-sdk";
import { MAINLAND, PRESETS, media, searches, shape, usable } from "./qwen.js";

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "Qwen (Alibaba Cloud)", zh: "通义千问（阿里云）" },
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
          ...(searches(profile.model) ? { webSearch: "chat" as const } : {}),
          body: (json, request) => shape(profile.model, json, request)
        })
    });
  }
});
