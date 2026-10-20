import { definePlugin } from "@tomradex/plugin-sdk";
import { opencode } from "./opencode.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(opencode);
  }
});
