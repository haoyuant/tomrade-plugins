import { definePlugin } from "@tomradex/plugin-sdk";
import { kimiKey, kimiProvider, type ProfileLike } from "./kimi.js";

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
    await ctx.webSearch.register(kimiProvider({ id: ctx.namespace, key: () => kimiKey(profiles) }));
  }
});
