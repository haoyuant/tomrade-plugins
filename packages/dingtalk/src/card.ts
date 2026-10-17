import type { ImContent } from "@tomradex/plugin-sdk";
import { obj } from "./wire.js";

/**
 * DingTalk's public AI card template, the one its own Stream SDK replies
 * with: Markdown that streams (`msgContent`), Markdown set at once
 * (`staticMsgContent`), a status, and buttons that call back over Stream.
 */
export const TEMPLATE = "382e4302-551d-4880-bf29-a30acfab2e71.schema";
/** `flowStatus`: 2 shows the card being written, 3 settles it. */
export const STATUS = { inputting: "2", finished: "3" } as const;
/** Buttons beyond these go as `/answer` lines. */
export const MAX_BUTTONS = 6;

const clip = (text: string, n: number) => ([...text].length > n ? `${[...text].slice(0, n - 1).join("")}…` : text);
const http = (url: string) => /^https?:\/\//i.test(url);

/**
 * Content as DingTalk Markdown: the text, sections, and links (app links as
 * text, since only web links open). Buttons a card cannot carry, or all of
 * them where nothing can be pressed, become the `/answer` lines the IM layer reads.
 */
export function markdownOf(content: ImContent, opts: { buttons?: boolean } = {}): string {
  const blocks = [content.text];
  for (const el of content.elements ?? []) {
    if (el.type === "section") blocks.push([el.title ? `**${el.title}**` : "", el.text ?? "", ...(el.fields ?? []).map(f => `**${f.label}**: ${f.value}`)].filter(Boolean).join("\n"));
    else if (el.type === "links") blocks.push(el.links.map(l => (http(l.url) ? `[${l.label}](${l.url})` : `${l.label}: ${l.url}`)).join("\n"));
  }
  const typed = (content.actions ?? []).slice(opts.buttons ? MAX_BUTTONS : 0);
  if (typed.length) blocks.push(typed.map(a => `${a.label}：/answer ${a.token}`).join("\n"));
  return blocks.filter(b => !!b.trim()).join("\n\n");
}

const TABLE_ROW = /^\s*\|?.*\|.*\|?\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const BLOCK = /^\s{0,3}(?:[-*+] |\d+[.)] |#{1,6} |\||> |```)/;

/**
 * DingTalk's card Markdown breaks a line only at `<br>`, and draws a table only
 * after a blank line: a single newline becomes `<br>` outside code and before
 * anything but block syntax, and a table gets its blank line.
 */
export function forCard(markdown: string): string {
  const src = markdown.replace(/\r\n?/g, "\n").split("\n");
  const lines: string[] = [];
  let code = false;
  for (const [i, line] of src.entries()) {
    const prev = lines.at(-1);
    if (!code && prev?.trim() && !TABLE_ROW.test(prev) && TABLE_ROW.test(line) && TABLE_RULE.test(src[i + 1] ?? "")) lines.push("");
    if (/^\s{0,3}```/.test(line)) code = !code;
    lines.push(line);
  }
  code = false;
  return lines.map((line, i) => {
    const fence = /^\s{0,3}```/.test(line);
    const inside = code;
    if (fence) code = !code;
    if (i === lines.length - 1) return line;
    const next = lines[i + 1]!;
    return inside || fence || code || !line.trim() || !next.trim() || BLOCK.test(next) ? `${line}\n` : `${line}<br>`;
  }).join("");
}

/** What a card shows for content: its Markdown with the card's line breaks. */
export const cardText = (content: ImContent) => forCard(markdownOf(content, { buttons: true }));

/** The card's variables for content in one state; `key` is the Markdown field it shows in. */
export function paramsOf(content: ImContent, status: string, key: "msgContent" | "staticMsgContent"): Record<string, string> {
  const text = cardText(content);
  // An empty button list clears the buttons when a question closes.
  const msgButtons = (content.actions ?? []).slice(0, MAX_BUTTONS).map(a => ({ text: clip(a.label, 20), id: a.token, color: "blue", request: true }));
  return {
    flowStatus: status,
    msgContent: key === "msgContent" ? text : "",
    staticMsgContent: key === "staticMsgContent" ? text : "",
    sys_full_json_obj: JSON.stringify({ order: [key, "msgButtons"], msgButtons }),
    config: JSON.stringify({ autoLayout: true })
  };
}

/** The button a card callback came from; its id is the IM layer's token. */
export function tokenOf(content: unknown): string | null {
  const data = obj(obj(content).cardPrivateData);
  const ids = Array.isArray(data.actionIds) ? data.actionIds : [];
  const token = typeof ids[0] === "string" ? ids[0] : typeof obj(data.params).id === "string" ? obj(data.params).id as string : null;
  return token && token.length <= 256 ? token : null;
}
