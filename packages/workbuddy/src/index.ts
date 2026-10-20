import { definePlugin } from "@tomradex/plugin-sdk";
import { workbuddy } from "./workbuddy.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(workbuddy);
  }
});
