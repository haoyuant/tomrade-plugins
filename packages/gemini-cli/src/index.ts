import { definePlugin } from "@tomradex/plugin-sdk";
import { gemini } from "./gemini.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(gemini);
  }
});
