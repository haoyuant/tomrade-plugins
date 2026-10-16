import { toImDialect, type ImContent } from "@tomradex/plugin-sdk";
import type { TButton, TKeyboard } from "./wire.js";

export const LIMIT = { text: 4096, data: 64, label: 64, options: 50 };
/** Marks a multi-select option as picked. */
export const CHECK = "✅ ";
const PEN = "✍️ ";

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

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const clip = (text: string, n: number) => ([...text].length > n ? `${[...text].slice(0, n - 1).join("")}…` : text);
/** Schemes a Telegram link or button opens; app links such as tomrade:// are shown as text. */
const openable = (url: string) => /^(https?|tg):\/\//i.test(url);

/** What a person sees once Telegram has parsed the HTML; the 4096 limit counts this. */
export const visible = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, "&").length;

export const plainOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

/** A link Telegram cannot open keeps its words and loses the link. */
const unwrap = (html: string) => html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (all, href: string, label: string) => (openable(href.replace(/&amp;/g, "&")) ? all : label));

/**
 * What a button hands back, as callback_data (64 bytes at most): its kind (`b`
 * a button, `o` a select's option, `m` a multi-select toggle, `M` its submit,
 * `i` a written answer, `x` a label), the IM layer's token, and an option's
 * index. A hex token goes as base64url, which fits with room to spare; any
 * other token as itself, or as a short alias this session remembers.
 */
export type Kind = "b" | "o" | "m" | "M" | "i" | "x";
export interface Control { kind: Kind; token: string; index?: number }

const HEX = /^(?:[0-9a-f]{2}){1,40}$/;

export class Codec {
  private readonly aliases = new Recent<string>(500);
  private n = 0;

  pack(kind: Kind, token: string, index?: number): string {
    const tail = index === undefined ? "" : `.${index}`;
    const data = `${kind}${HEX.test(token) ? Buffer.from(token, "hex").toString("base64url") : `~${token}`}${tail}`;
    if (Buffer.byteLength(data) <= LIMIT.data) return data;
    const alias = `!${(++this.n).toString(36)}`;
    this.aliases.set(alias, token);
    return `${kind}${alias}${tail}`;
  }

  unpack(data: string): Control | null {
    const kind = data[0] as Kind | undefined;
    if (!kind || !"bomMix".includes(kind)) return null;
    if (kind === "x") return { kind, token: "" };
    let rest = data.slice(1);
    let index: number | undefined;
    if (kind === "o" || kind === "m") {
      const dot = rest.lastIndexOf(".");
      index = Number(rest.slice(dot + 1));
      if (dot < 0 || !Number.isInteger(index)) return null;
      rest = rest.slice(0, dot);
    }
    const token = rest.startsWith("~") ? rest.slice(1) : rest.startsWith("!") ? this.aliases.get(rest) : /^[\w-]+$/.test(rest) ? Buffer.from(rest, "base64url").toString("hex") : undefined;
    return token ? { kind, token, ...(index !== undefined ? { index } : {}) } : null;
  }
}

/** Short buttons share a row; long ones get their own. */
function flow(buttons: TButton[]): TButton[][] {
  const rows: TButton[][] = [];
  let row: TButton[] = [], width = 0;
  for (const b of buttons) {
    const w = [...b.text].length;
    if (row.length && (row.length >= 3 || width + w > 30)) { rows.push(row); row = []; width = 0; }
    row.push(b);
    width += w;
  }
  if (row.length) rows.push(row);
  return rows;
}

/**
 * IM content as one Telegram message: the text (already HTML), sections in
 * bold with their fields, web links as link buttons and app links as text,
 * and an inline keyboard. Buttons answer at once; a select is a button per
 * option, a multi-select a toggle per option and a submit button; a written
 * answer is a ✍️ button that asks for a reply. Extras that would push the
 * text past 4096 characters are cut short.
 */
export function render(content: ImContent, codec: Codec): { text: string; keyboard?: TKeyboard } {
  const zh = /[㐀-鿿]/.test(`${content.text}${JSON.stringify(content.elements ?? [])}`);
  const blocks: string[] = [];
  const linkLines: string[] = [];
  const linkButtons: TButton[] = [];
  const controls: TButton[][] = [];
  let fallback: string | undefined;
  for (const el of content.elements ?? []) {
    switch (el.type) {
      case "section": {
        const lines = [el.title ? `<b>${esc(el.title)}</b>` : "", el.text ? toImDialect(el.text, "telegram-html") : "", ...(el.fields ?? []).map(f => `${esc(f.label)}: ${esc(f.value)}`)].filter(Boolean);
        if (lines.length) blocks.push(lines.join("\n"));
        break;
      }
      case "links":
        for (const l of el.links) {
          if (openable(l.url)) linkButtons.push({ text: clip(l.label, LIMIT.label), url: l.url });
          else linkLines.push(`${esc(l.label)}: ${esc(l.url)}`);
        }
        break;
      case "select": {
        // Several selects in one card each say what they pick.
        if (el.placeholder) controls.push([{ text: clip(el.placeholder, LIMIT.label), callback_data: "x" }]);
        fallback ??= el.placeholder;
        controls.push(...flow(el.options.slice(0, LIMIT.options).map((o, i) => ({ text: clip(o.label, LIMIT.label), callback_data: codec.pack(el.multiple ? "m" : "o", el.token, i) }))));
        if (el.multiple) controls.push([{ text: zh ? "确定" : "Submit", callback_data: codec.pack("M", el.token), style: "primary" }]);
        break;
      }
      case "input":
        controls.push([{ text: clip(`${PEN}${el.label}`, LIMIT.label), callback_data: codec.pack("i", el.token) }]);
        fallback ??= el.label;
        break;
    }
  }
  const actions = (content.actions ?? []).map(a => ({ text: clip(a.label, LIMIT.label), callback_data: codec.pack("b", a.token),
    ...(a.style === "primary" || a.style === "danger" ? { style: a.style } : {}) }));
  const rows = [...flow(actions), ...controls, ...linkButtons.map(b => [b])];
  let text = content.text;
  for (const block of [...blocks, ...(linkLines.length ? [linkLines.join("\n")] : [])]) {
    const next = text ? `${text}\n\n${block}` : block;
    if (visible(next) > LIMIT.text) { if (visible(`${text}\n…`) <= LIMIT.text) text += "\n…"; break; }
    text = next;
  }
  text = unwrap(text);
  if (!plainOf(text).trim()) text = esc(fallback ?? "…");
  return { text, ...(rows.length ? { keyboard: { inline_keyboard: rows } } : {}) };
}

const controlsOf = (keyboard: TKeyboard | undefined, codec: Codec) =>
  (keyboard?.inline_keyboard ?? []).flat().flatMap(b => {
    const c = b.callback_data ? codec.unpack(b.callback_data) : null;
    return c ? [{ button: b, control: c }] : [];
  });

/** A multi-select as its keyboard shows it, for a card this adapter no longer remembers: what is ticked, and each option's label. */
export function readSelect(keyboard: TKeyboard | undefined, codec: Codec, token: string): { picked: Set<number>; labels: Map<number, string> } {
  const picked = new Set<number>(), labels = new Map<number, string>();
  for (const { button, control } of controlsOf(keyboard, codec)) {
    if ((control.kind !== "m" && control.kind !== "o") || control.token !== token || control.index === undefined) continue;
    const ticked = button.text.startsWith(CHECK);
    if (ticked) picked.add(control.index);
    labels.set(control.index, ticked ? button.text.slice(CHECK.length) : button.text);
  }
  return { picked, labels };
}

/** The keyboard with one multi-select's ticks redrawn. */
export function retick(keyboard: TKeyboard, codec: Codec, token: string, picked: Set<number>): TKeyboard {
  return {
    inline_keyboard: keyboard.inline_keyboard.map(row => row.map(b => {
      const c = b.callback_data ? codec.unpack(b.callback_data) : null;
      if (c?.kind !== "m" || c.token !== token || c.index === undefined) return b;
      const label = b.text.startsWith(CHECK) ? b.text.slice(CHECK.length) : b.text;
      return { ...b, text: picked.has(c.index) ? `${CHECK}${label}` : label };
    }))
  };
}

/** The written answer a card asks for, read from its keyboard: a reply to the card is that answer. */
export const inputOf = (keyboard: TKeyboard | undefined, codec: Codec) => controlsOf(keyboard, codec).find(c => c.control.kind === "i");

export const labelOf = (button: TButton) => (button.text.startsWith(PEN) ? button.text.slice(PEN.length) : button.text);
