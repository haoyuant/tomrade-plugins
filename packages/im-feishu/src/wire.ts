import type { ImAddress } from "@tomradex/plugin-sdk";

/** Feishu's event payloads, only as far as this adapter reads them. */
export interface FHeader { event_id: string; event_type: string; tenant_key?: string; app_id?: string; create_time?: string }
export interface FEnvelope<T> { schema?: string; header: FHeader; event: T }
export interface FUserId { open_id?: string; user_id?: string; union_id?: string }
export interface FMention { key: string; id: FUserId; name: string }
export interface FMessage {
  message_id: string; root_id?: string; parent_id?: string; thread_id?: string;
  chat_id: string; chat_type: string; message_type: string; content: string; mentions?: FMention[];
}
export interface FMessageEvent { sender: { sender_id: FUserId; sender_type: string; tenant_key?: string }; message: FMessage }
export interface FCardAction {
  operator: FUserId & { tenant_key?: string };
  token?: string;
  action: { tag?: string; value?: unknown; option?: string; options?: string[]; input_value?: string; form_value?: Record<string, unknown>; name?: string };
  context?: { open_message_id?: string; open_chat_id?: string };
}
export interface FRecalled { message_id: string; chat_id: string }
export interface FMenu { operator: { operator_id: FUserId }; event_key: string }

/** A file a message carries: what the resource API needs to fetch it. */
export interface FileRef { key: string; type: "image" | "file"; name?: string }

/** A message's text with the bot's own @ removed and other people's spelled out, and the files it carries. */
export interface Parsed { text: string; mentioned: boolean; files: FileRef[] }

type PostItem = { tag: string; text?: string; href?: string; user_id?: string; user_name?: string; image_key?: string; file_key?: string; language?: string; emoji_type?: string };

const parseJson = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

/** A post's paragraphs, whether or not Feishu wrapped them in a locale. */
function postBody(content: Record<string, unknown>): { title?: string; content: PostItem[][] } | null {
  if (Array.isArray(content.content)) return content as { title?: string; content: PostItem[][] };
  for (const v of Object.values(content)) if (v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content)) return v as { title?: string; content: PostItem[][] };
  return null;
}

export function parseMessage(m: FMessage, botOpenId: string): Parsed {
  const mentions = m.mentions ?? [];
  const isBot = (key: string | undefined) => !!botOpenId && mentions.some(x => x.key === key && x.id.open_id === botOpenId);
  const named = (key: string) => { const x = mentions.find(y => y.key === key); return x ? `@${x.name}` : key; };
  let mentioned = mentions.some(x => x.id.open_id === botOpenId && !!botOpenId);
  const files: FileRef[] = [];
  const content = parseJson(m.content);
  let text = "";
  switch (m.message_type) {
    case "text":
      text = String(content.text ?? "").replace(/@_user_\d+|@_all/g, key => (isBot(key) ? "" : key === "@_all" ? "@all" : named(key)));
      break;
    case "post": {
      const post = postBody(content);
      const lines = (post?.content ?? []).map(line => line.map(item => {
        switch (item.tag) {
          case "text": return item.text ?? "";
          case "a": return item.href ? `[${item.text ?? item.href}](${item.href})` : item.text ?? "";
          case "at":
            if (isBot(item.user_id)) { mentioned = true; return ""; }
            return item.user_id === "all" ? "@all" : `@${item.user_name ?? named(item.user_id ?? "")}`;
          case "img": if (item.image_key) files.push({ key: item.image_key, type: "image" }); return "";
          case "media": if (item.file_key) files.push({ key: item.file_key, type: "file" }); return "";
          case "code_block": return `\`\`\`${item.language ?? ""}\n${item.text ?? ""}\n\`\`\``;
          case "hr": return "---";
          default: return item.text ?? "";
        }
      }).join("").trim());
      text = [post?.title, ...lines].filter(l => !!l).join("\n");
      break;
    }
    case "image":
      if (typeof content.image_key === "string") files.push({ key: content.image_key, type: "image" });
      break;
    case "file": case "audio": case "media":
      if (typeof content.file_key === "string") files.push({ key: content.file_key, type: "file", ...(typeof content.file_name === "string" ? { name: content.file_name } : {}) });
      break;
  }
  return { text: text.replace(/[ \t]+\n/g, "\n").trim(), mentioned, files };
}

/**
 * Where a message belongs: a chat, and inside it the topic (thread) it was
 * written in, named by the topic's first message so a reply can go back into it.
 */
export function addressOf(tenantId: string, m: Pick<FMessage, "chat_id" | "thread_id" | "root_id" | "message_id">): ImAddress {
  const topic = m.thread_id ? m.root_id || m.message_id : undefined;
  return { tenantId, conversationId: m.chat_id, ...(topic ? { topicId: topic } : {}) };
}

/** A resource the IM layer can ask for later: which message, which kind, which key. */
export const fileId = (messageId: string, f: FileRef) => `${messageId}|${f.type}|${f.key}`;
export function parseFileId(id: string): { messageId: string; type: "image" | "file"; key: string } | null {
  const [messageId, type, key] = id.split("|");
  return messageId && key && (type === "image" || type === "file") ? { messageId, type, key } : null;
}

/** Reactions by meaning; the adapter swaps "received" for the outcome. */
export const REACTIONS = { received: "OnIt", done: "DONE", failed: "CrossMark" } as const;

/** A bot-menu entry's key as the command it stands for: `new` and `/new` both run /new. */
export const menuCommand = (key: string) => (key.startsWith("/") ? key : `/${key}`).trim();
