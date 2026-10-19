import { definePlugin } from "@tomradex/plugin-sdk";
import { defaultProject, googleToken } from "./credentials.js";
import { ClaudeModel } from "./claude-model.js";
import { GeminiModel, keyedOnly } from "./model.js";
import { address, authorize, base, claudeId, listModels, media, open, projectOf, usable } from "./vertex.js";

/** Gemini 4 first, then the newest Gemini 3.x Flash and Pro. */
const PREFER = [/^gemini-4(\.\d+)?-/, /^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-pro(-preview)?$/];

export default definePlugin({
  inject: ["models"],
  async apply(ctx) {
    const fallback = base(await defaultProject());
    const token = googleToken();
    await ctx.models.registerProvider({
      id: ctx.namespace,
      title: { en: "Google Vertex AI", zh: "Google Vertex AI" },
      // gcloud's credentials stand in for a key
      keyRequired: false,
      baseURL: { default: fallback },
      presets: [
        {
          id: "vertex",
          title: "Google Vertex AI",
          model: "gemini-3.8-flash",
          prefer: PREFER,
          local: true,
          hint: { en: "With the credentials gcloud holds (gcloud auth application-default login); no key to paste", zh: "使用 gcloud 已有的凭证（gcloud auth application-default login），无需粘贴 Key" }
        },
        {
          id: "vertex-key",
          title: "Google Vertex AI (API key)",
          model: "gemini-3.8-flash",
          prefer: PREFER,
          keyPage: "https://console.cloud.google.com/agent-platform/studio/settings/api-keys",
          env: "GOOGLE_API_KEY",
          hint: { en: "A Vertex AI API key, express mode included; it reaches Gemini only", zh: "Vertex AI API Key（含快速模式），只能使用 Gemini" }
        }
      ],
      list: (endpoint, signal) => listModels(address(endpoint.baseURL, fallback), { apiKey: endpoint.apiKey, token }, signal),
      usable,
      capabilities: media,
      build: (profile) => {
        const baseURL = address(profile.baseURL, fallback);
        const claude = claudeId(profile.model);
        if (claude) {
          if (profile.apiKey.trim()) return keyedOnly(profile.model, "Anthropic's model");
          return new ClaudeModel({ baseURL, apiKey: "", token, model: claude, inputModalities: profile.inputModalities, provider: ctx.namespace });
        }
        if (!open(profile.model)) {
          return new GeminiModel({ baseURL, apiKey: profile.apiKey, token, model: profile.model, inputModalities: profile.inputModalities, provider: ctx.namespace });
        }
        if (profile.apiKey.trim()) return keyedOnly(profile.model, "an open model");
        // the open models answer on Vertex's OpenAI-compatible endpoint, the token asked for on every try
        return ctx.models.compatible({
          baseURL: `${baseURL}/endpoints/openapi`,
          apiKey: "",
          model: profile.model,
          inputModalities: profile.inputModalities,
          headers: () => authorize({ apiKey: "", token }, projectOf(baseURL))
        });
      }
    });
  }
});
