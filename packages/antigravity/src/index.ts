import { definePlugin } from "@tomradex/plugin-sdk";
import { agy } from "./agy.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(agy);
  }
});
