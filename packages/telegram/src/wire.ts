import type { ImAddress, ImContextMessage } from "@tomradex/plugin-sdk";

/** Telegram's Bot API objects, only as far as this adapter reads them. */
export interface TUser { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; language_code?: string }
export interface TChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; is_forum?: boolean }
export interface TEntity { type: string; offset: number; length: number; url?: string; user?: TUser; language?: string }
export interface TFile { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string; mime_type?: string; width?: number; height?: number }
export interface TButton { text: string; callback_data?: string; url?: string; style?: string }
export interface TKeyboard { inline_keyboard: TButton[][] }
export interface TMessage {
  message_id: number; message_thread_id?: number; is_topic_message?: boolean; is_automatic_forward?: boolean;
  from?: TUser; chat: TChat; date: number; edit_date?: number;
  reply_to_message?: TMessage; forum_topic_created?: { name: string };
  text?: string; entities?: TEntity[]; caption?: string; caption_entities?: TEntity[];
  photo?: TFile[]; document?: TFile; video?: TFile; audio?: TFile; voice?: TFile;
  reply_markup?: TKeyboard;
}
export interface TCallback { id: string; from: TUser; message?: TMessage; data?: string }
export interface TUpdate { update_id: number; message?: TMessage; edited_message?: TMessage; callback_query?: TCallback }

/** Telegram has no workspaces: every chat a bot is in shares one tenant. */
export const TENANT = "telegram";

/** The admin rights the bot uses in a group: the ones its add-to-group link asks for. */
export const ADMIN_RIGHTS = [["manage_topics", { en: "Manage Topics", zh: "管理话题" }]] as const;

/** Adds the bot to a group the person picks, asking to make it an admin with exactly those rights. */
export const addToGroup = (username: string) => `https://t.me/${username}?startgroup=tomrade&admin=${ADMIN_RIGHTS.map(([right]) => right).join("+")}`;

export interface Bot { id: number; username: string }

export const nameOf = (u: TUser) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
export const actorOf = (u: TUser) => ({ id: String(u.id), name: nameOf(u).slice(0, 256), isBot: u.is_bot });

/** Private chats have positive ids, groups negative ones. */
export const isPrivate = (chatId: string | number) => Number(chatId) > 0;

/**
 * Where a message belongs: its chat, and inside a forum the topic it was
 * written in. A reply chain in a plain group carries a thread id too, but is
 * not a topic.
 */
export function addressOf(m: Pick<TMessage, "chat" | "message_thread_id" | "is_topic_message">): ImAddress {
  return { tenantId: TENANT, conversationId: String(m.chat.id), ...(m.is_topic_message && m.message_thread_id ? { topicId: String(m.message_thread_id) } : {}) };
}

/** The message a reply really quotes; in a forum, every message also "replies" to its topic's opening. */
export const quotedOf = (m: TMessage) => (m.reply_to_message && !m.reply_to_message.forum_topic_created ? m.reply_to_message : undefined);

const tick = (s: string) => (s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``);

/**
 * A message's text as Markdown, with code, code blocks and links kept and the
 * bot's own @ removed. A command is cut to `/name`, so `/status@this_bot` reads
 * as `/status`; one meant for another bot is marked so the message is left alone.
 * Entity offsets count UTF-16 units, as JavaScript strings do.
 */
export function readText(m: TMessage, bot: Bot): { text: string; mentioned: boolean; command: "ours" | "other" | null } {
  const raw = m.text ?? m.caption ?? "";
  const entities = [...(m.entities ?? m.caption_entities ?? [])].sort((a, b) => a.offset - b.offset);
  const self = `@${bot.username}`.toLowerCase();
  let out = "", at = 0, mentioned = false;
  let command: "ours" | "other" | null = null;
  for (const e of entities) {
    if (e.offset < at) continue;
    const piece = raw.slice(e.offset, e.offset + e.length);
    let replaced: string | null = null;
    switch (e.type) {
      case "mention": if (piece.toLowerCase() === self) { mentioned = true; replaced = ""; } break;
      case "text_mention": if (e.user?.id === bot.id) { mentioned = true; replaced = ""; } break;
      case "bot_command": {
        if (e.offset !== 0) break;
        const [name, to] = piece.split("@");
        if (to && to.toLowerCase() !== bot.username.toLowerCase()) command = "other";
        else { command = "ours"; replaced = name!; }
        break;
      }
      case "code": replaced = tick(piece); break;
      case "pre": replaced = `\`\`\`${e.language ?? ""}\n${piece}\n\`\`\``; break;
      case "text_link": if (e.url) replaced = `[${piece}](${e.url})`; break;
    }
    if (replaced === null) continue;
    out += raw.slice(at, e.offset) + replaced;
    at = e.offset + e.length;
    // The space after a removed @ goes with it.
    if (replaced === "" && raw[at] === " ") at++;
  }
  out += raw.slice(at);
  return { text: out.replace(/[ \t]+\n/g, "\n").trim(), mentioned, command };
}

/** How a message reached the bot: a direct chat, an @ or a command, a reply to the bot, or group chatter (privacy mode off). */
export function activationOf(m: TMessage, bot: Bot, read: { mentioned: boolean; command: "ours" | "other" | null }): "dm" | "mention" | "reply" | "ambient" {
  if (m.chat.type === "private") return "dm";
  if (read.mentioned || read.command === "ours") return "mention";
  return quotedOf(m)?.from?.id === bot.id ? "reply" : "ambient";
}

/** A file a message carries; the size is missing when Telegram left it out. */
export interface FileRef { id: string; name: string; mimeType: string; size?: number }

export function filesOf(m: TMessage): FileRef[] {
  const out: FileRef[] = [];
  // Telegram sends a photo in several sizes, the largest last.
  const photo = m.photo?.at(-1);
  if (photo) out.push({ id: photo.file_id, name: `photo-${m.message_id}.jpg`, mimeType: "image/jpeg", ...(photo.file_size ? { size: photo.file_size } : {}) });
  for (const [kind, f, ext, mime] of [["file", m.document, "", "application/octet-stream"], ["video", m.video, ".mp4", "video/mp4"],
    ["audio", m.audio, ".mp3", "audio/mpeg"], ["voice", m.voice, ".ogg", "audio/ogg"]] as const) {
    if (f) out.push({ id: f.file_id, name: f.file_name || `${kind}-${m.message_id}${ext}`, mimeType: f.mime_type || mime, ...(f.file_size ? { size: f.file_size } : {}) });
  }
  return out;
}

/** What the update itself carries of the discussion: the quoted message, and a forum topic's name. */
export function contextOf(m: TMessage, bot: Bot): ImContextMessage[] {
  const out: ImContextMessage[] = [];
  const quoted = quotedOf(m);
  if (quoted?.from) {
    const text = readText(quoted, bot).text;
    if (text) out.push({ role: "quoted", messageId: String(quoted.message_id), author: actorOf(quoted.from), text });
  }
  const opening = m.reply_to_message;
  if (opening?.forum_topic_created && opening.from) out.push({ role: "root", messageId: String(opening.message_id), author: actorOf(opening.from), text: opening.forum_topic_created.name });
  return out;
}

/** Reactions by meaning, from the emoji a bot may set; one replaces the other. */
export const REACTIONS = { received: "👀", done: "👍", failed: "😢" } as const;
