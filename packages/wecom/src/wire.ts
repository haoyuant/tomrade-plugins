import { createDecipheriv } from "node:crypto";

/** WeCom's callback bodies, only as far as this adapter reads them. */
export interface WMedia { url?: string; aeskey?: string }
export interface WItem { msgtype?: string; text?: { content?: string }; image?: WMedia }
export interface WQuote {
  msgtype?: string; text?: { content?: string }; mixed?: { msg_item?: WItem[] }; voice?: { content?: string };
  image?: WMedia; file?: WMedia; video?: WMedia;
}
export interface WMessage {
  msgid: string; aibotid?: string; chatid?: string; chattype?: "single" | "group"; from?: { userid?: string; corpid?: string };
  msgtype: string; text?: { content?: string }; mixed?: { msg_item?: WItem[] }; voice?: { content?: string };
  image?: WMedia; file?: WMedia; video?: WMedia; quote?: WQuote;
}
export interface WCardEvent {
  card_type?: string; event_key?: string; task_id?: string;
  selected_items?: { selected_item?: { question_key?: string; option_ids?: { option_id?: string[] } }[] };
}
export interface WEvent extends Omit<WMessage, "msgtype"> {
  msgtype: "event";
  event?: { eventtype?: string; template_card_event?: WCardEvent };
}

/** A file a message carries: an encrypted download that lives five minutes, and its key. */
export interface FileRef { url: string; aeskey?: string; type: "image" | "file" | "video" }

/** A message's text, with a group's leading @mention of the bot removed, and the files it carries. */
export interface Parsed { text: string; files: FileRef[] }

export function parseMessage(m: WMessage): Parsed {
  const files: FileRef[] = [];
  const media = (type: FileRef["type"], x?: WMedia) => { if (x?.url) files.push({ url: x.url, type, ...(x.aeskey ? { aeskey: x.aeskey } : {}) }); };
  let text = "";
  switch (m.msgtype) {
    case "text": text = m.text?.content ?? ""; break;
    // Voice arrives already turned into text.
    case "voice": text = m.voice?.content ?? ""; break;
    case "mixed":
      text = (m.mixed?.msg_item ?? []).map(item => {
        if (item.msgtype === "image") media("image", item.image);
        return item.msgtype === "text" ? item.text?.content ?? "" : "";
      }).filter(Boolean).join("\n");
      break;
    case "image": case "file": case "video": media(m.msgtype, m[m.msgtype]); break;
  }
  if (m.chattype === "group") text = withoutMention(text);
  return { text: text.trim(), files };
}

/**
 * A group message reaches the bot only when it @mentions it, and WeCom keeps
 * the mention at the start of the text. Mentions of others stay, unless a
 * command follows them: `@Bot @Ann /status` still runs /status.
 */
export function withoutMention(text: string): string {
  const rest = text.replace(/^\s*@\S+\s*/, "");
  return /^(?:@\S+\s+)+(\/[\s\S]*)$/.exec(rest)?.[1] ?? rest;
}

/** What a quoted message said, as far as the quote carries it. */
export function quoteText(q: WQuote): string {
  switch (q.msgtype) {
    case "voice": return q.voice?.content ?? "";
    case "mixed": return (q.mixed?.msg_item ?? []).map(i => (i.msgtype === "text" ? i.text?.content ?? "" : "[image]")).join("\n").trim();
    case "image": return "[image]";
    case "file": return "[file]";
    case "video": return "[video]";
    default: return q.text?.content?.trim() ?? "";
  }
}

/**
 * A downloaded file decrypted: AES-256-CBC with the message's own key, the
 * IV its first sixteen bytes, PKCS#7 padded to a multiple of 32 bytes.
 */
export function decrypt(data: Uint8Array, aeskey: string): Uint8Array {
  const key = Buffer.from(aeskey, "base64");
  if (key.length !== 32) throw new Error("WeCom gave a file key of the wrong length");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  const pad = out[out.length - 1] ?? 0;
  if (pad < 1 || pad > 32 || pad > out.length || out.subarray(out.length - pad).some(b => b !== pad)) throw new Error("WeCom file did not decrypt");
  return new Uint8Array(out.subarray(0, out.length - pad));
}

/** A type from the bytes themselves; WeCom serves every file as an opaque download. */
export function sniff(b: Uint8Array): string | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  return undefined;
}

const BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip", mp4: "video/mp4",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};
export const mimeByName = (name?: string) => (name ? BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] : undefined);
export const extOf = (mime: string) => Object.entries(BY_EXT).find(([, m]) => m === mime)?.[0];

/** The file name a download names in its Content-Disposition. */
export function fileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const raw = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  if (!raw) return undefined;
  try { return decodeURIComponent(raw).trim() || undefined; } catch { return raw.trim() || undefined; }
}
