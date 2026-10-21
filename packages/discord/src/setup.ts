import type { ImAdapter } from "@tomradex/plugin-sdk";
import type { DInteraction, DOption } from "./wire.js";

type IO = Parameters<ImAdapter["open"]>[1];
type Rest = (method: string, path: string, body?: unknown) => Promise<Record<string, unknown> | null>;
interface DChannel { id: string; type: number; name: string; parent_id?: string | null; topic?: string | null }

const KINDS = ["work", "status", "chat"] as const;
type Kind = typeof KINDS[number];
const CATEGORY = 4;
const TEXT = 0;
/** Administrator, Manage Channels. */
const ADMINISTRATOR = 1n << 3n;
export const MANAGE_CHANNELS = 1n << 4n;
const MISSING_PERMISSIONS = 50013;

const WORDS = {
  en: {
    command: "Create Tomrade's work, status and chat channels in this server",
    project: "The project the channels are for",
    names: { work: "tomrade-work", status: "tomrade-status", chat: "tomrade-chat" },
    topics: {
      work: (p: string) => `Tomrade: a thread for each ticket of ${p} being worked`,
      status: (p: string) => `Tomrade: news of ${p}'s tickets and code`,
      chat: (p: string) => `Tomrade: talk to ${p}'s assistant by @mentioning the bot`
    },
    done: (p: string, ids: Record<Kind, string>) => [`Tomrade is set up for **${p}**:`,
      `<#${ids.work}> — a thread for each ticket being worked`,
      `<#${ids.status}> — ticket and code news, routines, and when Tomrade comes online or goes offline`,
      `<#${ids.chat}> — @mention me to talk to the assistant`,
      "Run /tomrade setup again any time to put back what is missing; change what each channel hears in Tomrade's IM settings."].join("\n"),
    stranger: "Only the person paired with Tomrade can set up its channels. Pair first: send me a direct message with the code from Tomrade's IM settings.",
    older: "This needs a newer Tomrade. Update it, or @mention me in a channel to allow that channel.",
    server: "Run /tomrade setup in a channel of the server you want to set up.",
    manage: (url: string) => `I can't create channels here: the bot is missing the **Manage Channels** permission. Add the bot again with this link, keeping Manage Channels ticked, then run /tomrade setup again:\n${url}`,
    failed: (e: string) => `Setting up stopped: ${e}. Run /tomrade setup again to retry.`
  },
  zh: {
    command: "在这个服务器里创建 Tomrade 的工作、状态和聊天频道",
    project: "这些频道用于哪个项目",
    names: { work: "tomrade-工作", status: "tomrade-状态", chat: "tomrade-聊天" },
    topics: {
      work: (p: string) => `Tomrade：${p} 每个进行中的工单一个话题`,
      status: (p: string) => `Tomrade：${p} 的工单和代码动态`,
      chat: (p: string) => `Tomrade：@机器人和 ${p} 的助手对话`
    },
    done: (p: string, ids: Record<Kind, string>) => [`Tomrade 已为 **${p}** 设置好：`,
      `<#${ids.work}> — 每个进行中的工单一个话题`,
      `<#${ids.status}> — 工单和代码动态、例行任务，以及 Tomrade 上线下线`,
      `<#${ids.chat}> — @我即可和助手对话`,
      "随时再运行 /tomrade setup 补回缺少的频道；每个频道收什么，在 Tomrade 的 IM 设置里改。"].join("\n"),
    stranger: "只有和 Tomrade 配对过的人才能设置它的频道。请先配对：私信我 Tomrade IM 设置里的配对码。",
    older: "这需要更新版本的 Tomrade。请更新，或者在频道里 @我来允许那个频道。",
    server: "请在要设置的服务器的某个频道里运行 /tomrade setup。",
    manage: (url: string) => `我无法在这里创建频道：机器人缺少 **Manage Channels**（管理频道）权限。用这个链接重新添加机器人，保持勾选 Manage Channels，然后再运行 /tomrade setup：\n${url}`,
    failed: (e: string) => `设置中断：${e}。再运行一次 /tomrade setup 即可重试。`
  }
};
const wordsFor = (locale: string | undefined) => locale?.startsWith("zh") ? WORDS.zh : WORDS.en;

/** The `/tomrade setup` subcommand, only where the host can allow the channels it makes. */
export function setupCommand(io: IO) {
  if (!io.allow || !io.projects) return [];
  return [{
    type: 1, name: "setup", description: WORDS.en.command, description_localizations: { "zh-CN": WORDS.zh.command, "zh-TW": WORDS.zh.command },
    options: [{ type: 3, name: "project", description: WORDS.en.project, description_localizations: { "zh-CN": WORDS.zh.project, "zh-TW": WORDS.zh.project }, required: false, autocomplete: true }]
  }];
}

/** The setup subcommand of a `/tomrade` interaction, if that is what it is. */
export const setupOf = (i: DInteraction): DOption | undefined => i.data?.name === "tomrade" && i.data.options?.[0]?.name === "setup" ? i.data.options[0] : undefined;

/** Autocomplete for the project option: the person's projects whose name has what they typed. */
export function projectChoices(io: IO, i: DInteraction, actorId: string) {
  const typed = (setupOf(i)?.options?.find(o => o.name === "project")?.value ?? "").toLowerCase();
  return (io.projects?.(actorId) ?? []).filter(p => p.name.toLowerCase().includes(typed)).slice(0, 25).map(p => ({ name: p.name.slice(0, 100), value: p.id }));
}

/** A channel's mark of what it is for, kept in its topic so a rerun finds it after a rename. */
const mark = (projectId: string, kind: Kind) => `tomrade:${projectId}:${kind}`;
const markOf = (topic: string | null | undefined) => /tomrade:([^:\s]+):(work|status|chat)\b/.exec(topic ?? "");
const slug = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";

/**
 * Creates (or finds) the Tomrade category and its work, status and chat channels for the person's project, and
 * allows each with its kind; what exists is reused and nothing is deleted. Answers with what to say.
 */
export async function setUp(io: IO, rest: Rest, i: DInteraction, actorId: string, install: string, learn: (c: DChannel) => void): Promise<string> {
  const w = wordsFor(i.locale);
  if (!io.allow || !io.projects) return w.older;
  const projects = io.projects(actorId);
  if (!projects.length) return w.stranger;
  const guild = i.guild_id;
  if (!guild) return w.server;
  const chosen = setupOf(i)?.options?.find(o => o.name === "project")?.value;
  const project = projects.find(p => p.id === chosen) ?? projects[0]!;
  if (i.app_permissions !== undefined) {
    const bits = BigInt(i.app_permissions);
    if (!(bits & ADMINISTRATOR) && !(bits & MANAGE_CHANNELS)) return w.manage(install);
  }
  try {
    const channels = await rest("GET", `/guilds/${guild}/channels`) as unknown as DChannel[];
    // Another project set up here already: this one's channels carry its name.
    const shared = channels.some(c => { const m = markOf(c.topic); return !!m && m[1] !== project.id; });
    const name = (kind: Kind) => shared ? `${w.names[kind]}-${slug(project.name)}` : w.names[kind];
    let category = channels.find(c => c.type === CATEGORY && c.name.toLowerCase() === "tomrade");
    const ids = {} as Record<Kind, string>;
    for (const kind of KINDS) {
      let channel = channels.find(c => { const m = markOf(c.topic); return !!m && m[1] === project.id && m[2] === kind; })
        ?? channels.find(c => c.type === TEXT && c.name === name(kind));
      if (!channel) {
        category ??= await rest("POST", `/guilds/${guild}/channels`, { name: "Tomrade", type: CATEGORY }) as unknown as DChannel;
        channel = await rest("POST", `/guilds/${guild}/channels`, { name: name(kind), type: TEXT, parent_id: category.id,
          topic: `${w.topics[kind](project.name)} · ${mark(project.id, kind)}` }) as unknown as DChannel;
        learn(channel);
      }
      ids[kind] = channel.id;
    }
    for (const kind of KINDS) io.allow({ actorId, address: { tenantId: guild, conversationId: ids[kind] }, kind, projectId: project.id });
    return w.done(project.name, ids);
  } catch (e) {
    if ((e as { code?: unknown }).code === MISSING_PERMISSIONS) return w.manage(install);
    return w.failed((e as Error).message);
  }
}
