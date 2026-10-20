import type { ImAddress } from "@tomradex/plugin-sdk";

/** Slack's payloads, only as far as this adapter reads them. */
export interface SFile {
  id: string; name?: string; title?: string; mimetype?: string; size?: number; mode?: string; file_access?: string;
  url_private?: string; url_private_download?: string;
}
export interface SMessage {
  type: string; subtype?: string; channel: string; channel_type?: string; user?: string; bot_id?: string; text?: string;
  ts: string; thread_ts?: string; event_ts?: string; files?: SFile[]; edited?: { user?: string; ts: string };
  message?: SMessage; previous_message?: SMessage; metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
}
export interface SEventCallback { type: string; team_id?: string; event_id: string; event: { type: string } & Record<string, unknown> }
export interface SStopped { type: "agent_session_stopped"; user?: string; channel?: string; thread_ts?: string; event_ts?: string; streaming_message_ts?: string[] }
export interface SAction {
  action_id: string; block_id: string; type: string; value?: string;
  selected_option?: { value: string } | null; selected_options?: { value: string }[];
}
export type SState = Record<string, Record<string, { type: string; value?: string | null; selected_option?: { value: string } | null; selected_options?: { value: string }[] }>>;
export interface SBlockActions {
  type: string; trigger_id?: string; user?: { id: string };
  channel?: { id: string }; container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts: string; thread_ts?: string }; state?: { values: SState }; actions?: SAction[];
}
export interface SCommand { command?: string; text?: string; user_id?: string; channel_id?: string; trigger_id?: string }

const TS = /^\d+\.\d+$/;

/** A direct message channel; channels, private channels and group DMs are groups. */
export const isDirect = (channel: string) => channel.startsWith("D");

/** A message's id: its own ts, and the thread it was written in, so a reply finds the thread and a reaction the message. */
export const messageId = (ts: string, thread?: string) => (thread && thread !== ts ? `${ts}@${thread}` : ts);

/** The thread a reply to this id goes into; nothing for an id that names no message, like a slash command's. */
export function threadOf(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const [own = "", thread] = id.split("@");
  return thread ?? (TS.test(own) ? own : undefined);
}

/** The message an id names, for a reaction. */
export function tsOf(id: string): string | undefined {
  const own = id.split("@")[0] ?? "";
  return TS.test(own) ? own : undefined;
}

/** The metadata event type on a ticket thread's parent message, which marks the thread as that ticket's topic. */
export const TOPIC_EVENT = "tomrade_topic";

/**
 * Where a message belongs. A direct message's thread is a conversation of its
 * own, as Slack's agent view shows it; a channel is one conversation, and each
 * answer goes into the thread of the message that asked. A ticket's thread in
 * a channel (`ticket`) is that ticket's topic.
 */
export function addressOf(team: string, channel: string, ts: string | undefined, thread: string | undefined, ticket = false): ImAddress {
  const reply = thread && thread !== ts ? thread : undefined;
  const topic = isDirect(channel) ? reply ?? ts : ticket ? reply : undefined;
  return { tenantId: team, conversationId: channel, ...(topic ? { topicId: topic } : {}) };
}

/** Whether a message's text @mentions this user. */
export const mentions = (text: string, userId: string) => !!userId && (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`));

/** The people a message names, so their names can be read before its text is written out. */
export const usersIn = (text: string) => [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]!))];

/**
 * A message's text as the Agent reads it: the bot's own mention dropped,
 * people, channels and groups by name, links as Markdown, entities decoded.
 */
export function textOf(text: string, botUserId: string, nameOf: (id: string) => string | undefined = () => undefined): string {
  return text.replace(/<([^<>\n]+)>/g, (_, inner: string) => {
    const bar = inner.indexOf("|");
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? undefined : inner.slice(bar + 1);
    if (target.startsWith("@")) return target.slice(1) === botUserId ? "" : `@${nameOf(target.slice(1)) ?? label ?? target.slice(1)}`;
    if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
    if (target.startsWith("!subteam^")) return label ?? "@group";
    if (target.startsWith("!date^")) return label ?? "";
    if (target.startsWith("!")) return `@${target.slice(1)}`;
    return label === undefined || label === target ? target.replace(/^mailto:/, "") : `[${label}](${target})`;
  }).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").trim();
}

/** The IM layer's commands; `/tomrade <command> …` runs one, anything else is said to the assistant. */
const COMMANDS = new Set(["stop", "status", "new", "answer", "steer", "queue", "sessions", "switch", "archive", "engine", "model", "effort", "mode", "start", "unqueue", "help", "pair"]);

/** What `/tomrade` was given, as the message the IM layer reads: `status` runs /status, empty is /help. */
export function commandText(text: string): string {
  const t = text.trim().replace(/^\//, "");
  if (!t) return "/help";
  const head = /^\S+/.exec(t)![0];
  return COMMANDS.has(head.toLowerCase()) ? `/${head.toLowerCase()}${t.slice(head.length)}` : text.trim();
}

/** Reactions by meaning; the adapter swaps "received" for the outcome. */
export const REACTIONS = { received: "eyes", done: "white_check_mark", failed: "x" } as const;
