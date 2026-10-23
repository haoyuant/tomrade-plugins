import { definePlugin } from "@tomradex/plugin-sdk";
import { hermes } from "./hermes.js";
import { hermesAsk } from "./lend.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    // Background calls say a refusal in the app's language.
    await ctx.agent.localAgent({ ...hermes, lend: { ...hermes.lend, ask: async (request, io) => hermesAsk(request, io, await ctx.settings.locale().catch(() => "en")) } });
  }
});
