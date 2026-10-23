import { definePlugin, type PluginContext } from "@tomradex/plugin-sdk";
import { clearRegionFile, setRegionFile, type Region } from "./config.js";
import { WorkBuddyOptions, workbuddy } from "./workbuddy.js";

/** The edition the settings now say, or auto when they cannot be read (the session then changes nothing). */
async function chosenRegion(ctx: PluginContext): Promise<Region> {
  try {
    const agent = (await ctx.settings.get("agent")) as { engines?: Record<string, Record<string, unknown>> } | undefined;
    return WorkBuddyOptions.parse(agent?.engines?.workbuddy ?? {}).region;
  } catch {
    return "auto";
  }
}

/**
 * The edition is one machine-wide choice, so it is written into CodeBuddy's
 * own settings (sign-in and later terminal runs read those) as well as the
 * session's environment. Auto writes nothing and takes back only the value
 * this plugin wrote; a person's own value is never touched.
 */
export default definePlugin({
  inject: ["agent", "settings"],
  async apply(ctx) {
    await ctx.agent.localAgent(workbuddy);

    const write = (region: Region, previous: Region) => {
      try {
        const result = region === "auto"
          ? previous === "auto" ? "kept" : clearRegionFile(previous)
          : setRegionFile(region);
        if (result === "unreadable") ctx.logger?.warn("[workbuddy] CodeBuddy's settings.json is unreadable; leaving its edition alone");
      } catch (error) {
        ctx.logger?.warn("[workbuddy] could not set the CodeBuddy edition: " + (error instanceof Error ? error.message : String(error)));
      }
    };

    let last = await chosenRegion(ctx);
    if (last !== "auto") write(last, "auto");

    // A burst of settings writes settles in order, the last choice winning.
    let running = false;
    let again = false;
    const sync = async () => {
      if (running) { again = true; return; }
      running = true;
      do {
        again = false;
        const next = await chosenRegion(ctx);
        if (next !== last) {
          write(next, last);
          last = next;
        }
      } while (again);
      running = false;
    };
    if (typeof ctx.on === "function") ctx.on("settings.changed", () => { void sync(); });
  }
});
