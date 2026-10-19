import { definePlugin } from "@tomradex/plugin-sdk";
import { deepseekKey, deepseekProvider, type ProfileLike } from "./deepseek.js";

export default definePlugin({
  inject: ["settings", "webSearch"],
  async apply(ctx) {
    // The core asks a provider whether it is set up synchronously, so the model profiles are kept at hand and reread when settings change.
    let profiles: ProfileLike[] = [];
    const load = async () => {
      profiles = (await ctx.settings.get<{ profiles?: ProfileLike[] } | undefined>("models"))?.profiles ?? [];
    };
    await load();
    ctx.on("settings.changed", load);
    await ctx.webSearch.register(deepseekProvider({ id: ctx.namespace, key: () => deepseekKey(profiles) }));
  }
});
