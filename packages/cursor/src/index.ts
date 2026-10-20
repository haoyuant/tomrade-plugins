import { definePlugin } from "@tomradex/plugin-sdk";
import { cursor } from "./cursor.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(cursor);
  }
});
