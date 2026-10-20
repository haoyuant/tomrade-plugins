import { definePlugin } from "@tomradex/plugin-sdk";
import { dsh } from "./dsh.js";

export default definePlugin({
  inject: ["agent"],
  async apply(ctx) {
    await ctx.agent.localAgent(dsh);
  }
});
