import type { ImAddress } from "@tomradex/plugin-sdk";

/** Remembers the most recent `max` entries. */
export class Recent<V> extends Map<string, V> {
  constructor(private readonly max: number) { super(); }
  override set(key: string, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

/** A robot message as Stream mode delivers it, only as far as this adapter reads it. */
export interface DMessage {
  msgId?: string; msgtype?: string; createAt?: number;
  conversationId?: string; conversationType?: string; conversationTitle?: string;
  senderId?: string; senderStaffId?: string; senderNick?: string; senderCorpId?: string;
  chatbotCorpId?: string; chatbotUserId?: string; robotCode?: string;
  isInAtList?: boolean; atUsers?: { dingtalkId?: string; staffId?: string }[];
  sessionWebhook?: string; sessionWebhookExpiredTime?: number | string;
  text?: { content?: string; isReplyMsg?: boolean; repliedMsg?: unknown };
  /** An object, or the same as a JSON string. */
  content?: unknown;
}
/** A card button pressed: which card, by whom, and the button's id in `content.cardPrivateData.actionIds`. */
export interface DCardCallback { outTrackId?: string; userId?: string; corpId?: string; content?: unknown; spaceType?: string; spaceId?: string; type?: string }

/** A file a message carries: the code DingTalk exchanges for a download address. */
export interface FileRef { code: string; kind: "image" | "file"; name?: string }

/** A message's text, its files, and the message it quotes. */
export interface Parsed { text: string; files: FileRef[]; quoted?: { messageId: string; senderId?: string; text: string } }

type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => {
  if (typeof v === "string") { try { const p = JSON.parse(v) as unknown; return p && typeof p === "object" ? p as Obj : {}; } catch { return {}; } }
  return v && typeof v === "object" ? v as Obj : {};
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const texts = (items: unknown) => (Array.isArray(items) ? items as Obj[] : []).map(i => str(i.text)).filter((t): t is string => !!t).join("\n");

/** What a quote shows, for the context the Agent reads; a card's text is not in the quote. */
function quoteOf(container: Obj): Parsed["quoted"] {
  if (!container.isReplyMsg) return undefined;
  const r = obj(container.repliedMsg);
  const messageId = str(r.msgId);
  if (!messageId) return undefined;
  const c = obj(r.content);
  const type = str(r.msgType) ?? "text";
  const text = type === "text" || type === "markdown" ? str(c.text) ?? str(r.text) ?? ""
    : type === "richText" ? texts(c.richText)
    : type === "picture" ? "[picture]" : type === "file" ? `[file: ${str(c.fileName) ?? ""}]` : type === "interactiveCard" ? "" : `[${type}]`;
  const senderId = str(r.senderId);
  return { messageId, ...(senderId ? { senderId } : {}), text: text.trim() };
}

export function parseMessage(m: DMessage): Parsed {
  const content = obj(m.content);
  const files: FileRef[] = [];
  let text = "";
  let container: Obj = {};
  switch (m.msgtype) {
    case "text":
      text = m.text?.content ?? "";
      container = (m.text ?? {}) as Obj;
      break;
    case "richText":
      for (const item of (Array.isArray(content.richText) ? content.richText as Obj[] : [])) {
        const code = str(item.downloadCode);
        if (str(item.text)) text += `${text ? "\n" : ""}${item.text as string}`;
        else if (code) files.push({ code, kind: !item.type || item.type === "picture" ? "image" : "file", ...(str(item.fileName) ? { name: item.fileName as string } : {}) });
      }
      container = content;
      break;
    case "picture":
      if (str(content.downloadCode)) files.push({ code: content.downloadCode as string, kind: "image" });
      break;
    case "file": case "video": {
      const name = str(content.fileName) ?? (m.msgtype === "video" ? `video.${str(content.videoType) ?? "mp4"}` : undefined);
      if (str(content.downloadCode)) files.push({ code: content.downloadCode as string, kind: "file", ...(name ? { name } : {}) });
      break;
    }
    // A voice message arrives already transcribed.
    case "audio":
      text = str(content.recognition) ?? "";
      break;
  }
  const quoted = quoteOf(container);
  return { text: text.replace(/[ \t]+\n/g, "\n").trim(), files, ...(quoted ? { quoted } : {}) };
}

/** Direct chats are named by the person, so a reply can reach them after a restart; a group by its open conversation id. */
export const DM = "user:";

export function addressOf(m: DMessage): ImAddress {
  const tenantId = m.chatbotCorpId || m.senderCorpId || "dingtalk";
  return { tenantId, conversationId: m.conversationType === "2" ? m.conversationId ?? "" : `${DM}${m.senderStaffId || m.senderId || ""}` };
}

export type Target = { dm: true; userId: string } | { dm: false; group: string };
export const targetOf = (a: ImAddress): Target => (a.conversationId.startsWith(DM) ? { dm: true, userId: a.conversationId.slice(DM.length) } : { dm: false, group: a.conversationId });

/** A file the IM layer can ask for later; the download code is carried along while it fits. */
export const fileId = (f: FileRef) => `${f.kind === "image" ? "i" : "f"}|${f.code}`;
export function parseFileId(id: string): FileRef | null {
  const at = id.indexOf("|");
  const kind = id.slice(0, at);
  return at > 0 && (kind === "i" || kind === "f") ? { code: id.slice(at + 1), kind: kind === "i" ? "image" : "file" } : null;
}

/** The title DingTalk shows in notifications and the chat list: the first line, plain. */
export function titleOf(markdown: string): string {
  const line = markdown.split("\n").map(l => l.replace(/[#>*_`~[\]]|\(https?:[^)]*\)/g, "").trim()).find(Boolean) ?? "";
  return [...line].length > 30 ? `${[...line].slice(0, 29).join("")}…` : line || "Tomrade";
}
