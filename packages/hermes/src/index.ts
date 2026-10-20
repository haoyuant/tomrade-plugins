import { definePlugin } from "@tomradex/plugin-sdk";
import { hermes } from "./hermes.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(hermes);
  }
});
