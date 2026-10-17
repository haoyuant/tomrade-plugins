import type { ImButton, ImContent, ImElement } from "@tomradex/plugin-sdk";
import type { WCardEvent } from "./wire.js";

/**
 * What a card's controls stand for, kept to read its callbacks and to show
 * the answer on it. Button keys carry the IM layer's token (`b.<token>`), so
 * a press still counts after a restart; a select's options carry their value
 * (`v.<value>`) where it is short and plain, else their index.
 */
export interface Control {
  kind: "buttons" | "choice" | "select";
  multiple?: boolean;
  options: { id: string; label: string; value?: string }[];
}
export interface Card { card: Record<string, unknown>; control: Control }
/** IM content as WeCom messages: Markdown first, then one template card per control group. */
export interface Plan { markdown: string; cards: Card[] }

/** Template cards take short plain text only. */
export const LIMIT = { title: 26, sub: 112, button: 10, option: 11, buttons: 6, options: 20 };
export const SUBMIT = "提交";
/** WeCom shows a stream that holds only this as its own "thinking" state. */
export const THINKING = "<think></think>";

/** Width as WeCom counts a card's 字: a CJK character is one, a Latin letter about half. */
const width = (s: string) => [...s].reduce((w, c) => w + (c.codePointAt(0)! < 0x2e80 ? 0.5 : 1), 0);
function clip(text: string, n: number): string {
  if (width(text) <= n) return text;
  let out = "";
  for (const c of text) {
    if (width(out + c) > n - 0.5) break;
    out += c;
  }
  return `${out}…`;
}
const http = (url: string) => /^https?:\/\//i.test(url);
const SAFE = /^[A-Za-z0-9_.@-]{1,100}$/;

/** Markdown as the plain text a card field shows. */
export function plain(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?think>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, "")
    .replace(/\*\*|__|~~|`/g, "")
    .trim();
}

/** WeCom counts a message's 20480 bytes in UTF-8. */
export function clipBytes(text: string, max = 20_480): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return `${new TextDecoder().decode(bytes.slice(0, max - 3)).replace(/�+$/, "")}…`;
}

/** Sections and links in Markdown: web links as links, app links (`tomrade://`) as text, which WeCom will not open. */
function markdownOf(el: ImElement): string {
  switch (el.type) {
    case "section": return [el.title ? `**${el.title}**` : "", el.text ?? "", ...(el.fields ?? []).map(f => `**${f.label}**: ${f.value}`)].filter(Boolean).join("\n");
    case "links": return el.links.map(l => (http(l.url) ? `[${l.label}](${l.url})` : `${l.label}: ${l.url}`)).join("\n");
    default: return "";
  }
}

/**
 * The messages one delivery becomes. Short text with a single card rides in
 * the card's title and subtitle; longer text, sections and links go as
 * Markdown above it, as they must when `markdown` (the text fills a stream).
 * Buttons make a button card (six at most, else a single-choice vote);
 * each select a vote card. Labels too long for a card are numbered there and
 * spelled out in the Markdown.
 */
export function planOf(content: ImContent, opts: { taskId(index: number): string; markdown?: boolean }): Plan {
  const extra: string[] = [];
  const notes: string[] = [];
  const pending: { build(title: string, sub?: string): Record<string, unknown>; control: Control; title?: string }[] = [];
  for (const el of content.elements ?? []) {
    if (el.type === "select") pending.push(select(el, notes));
    else if (el.type === "section" || el.type === "links") extra.push(markdownOf(el));
  }
  const actions = content.actions ?? [];
  if (actions.length) pending.unshift(actions.length <= LIMIT.buttons ? buttons(actions, notes) : choice(actions, notes));

  const text = content.text.trim();
  const lines = plain(text).split("\n").map(l => l.trim()).filter(Boolean);
  const head = lines[0] ?? "";
  const rest = lines.slice(1).join("\n");
  const absorb = !opts.markdown && pending.length === 1 && !extra.length && !notes.length && width(head) <= LIMIT.title && width(rest) <= LIMIT.sub;
  const markdown = absorb ? "" : [text, ...extra.filter(Boolean), ...notes].filter(Boolean).join("\n\n");
  const cards = pending.map((p, i) => {
    const title = absorb && head ? head : clip(head || p.title || "…", LIMIT.title);
    const card = { ...p.build(title || "…", absorb && rest ? rest : undefined), task_id: opts.taskId(i) };
    return { card, control: p.control };
  });
  return { markdown, cards };
}

const titled = (title: string, sub?: string) => ({ main_title: { title }, ...(sub ? { sub_title_text: sub } : {}) });

/** Labels that fit as they are, or numbered ones whose full text the Markdown spells out. */
function labels(all: string[], max: number, notes: string[]): string[] {
  if (all.every(l => width(l) <= max)) return all;
  notes.push(all.map((l, i) => `${i + 1}. ${l}`).join("\n"));
  return all.map((l, i) => clip(`${i + 1}. ${l}`, max));
}

function buttons(actions: ImButton[], notes: string[]) {
  const shown = labels(actions.map(a => a.label), LIMIT.button, notes);
  const options = actions.map(a => ({ id: `b.${a.token}`, label: a.label }));
  return {
    control: { kind: "buttons" as const, options },
    build: (title: string, sub?: string) => ({ card_type: "button_interaction", ...titled(title, sub), button_list: options.map((o, i) => ({ text: shown[i]!, key: o.id })) })
  };
}

/** More buttons than a card holds: one single-choice vote whose options are the buttons. */
function choice(actions: ImButton[], notes: string[]) {
  const kept = actions.slice(0, LIMIT.options);
  const overflow = actions.slice(LIMIT.options);
  if (overflow.length) notes.push(overflow.map(a => `${a.label}: /answer ${a.token}`).join("\n"));
  const shown = labels(kept.map(a => a.label), LIMIT.option, notes);
  const options = kept.map(a => ({ id: `b.${a.token}`, label: a.label }));
  return {
    control: { kind: "choice" as const, options },
    build: (title: string, sub?: string) => vote(title, sub, "a", false, options.map((o, i) => ({ id: o.id, text: shown[i]! })))
  };
}

function select(el: Extract<ImElement, { type: "select" }>, notes: string[]) {
  const kept = el.options.slice(0, LIMIT.options);
  const overflow = el.options.slice(LIMIT.options);
  if (overflow.length) notes.push(el.multiple ? `${overflow.map(o => o.label).join(", ")}: /answer ${el.token} ${JSON.stringify(overflow.map(o => o.value))}`
    : overflow.map(o => `${o.label}: /answer ${el.token} ${o.value}`).join("\n"));
  const values = kept.map(o => o.value);
  const options = kept.map((o, i) => ({ id: SAFE.test(o.value) && values.indexOf(o.value) === i ? `v.${o.value}` : `o${i}`, label: o.label, value: o.value }));
  const shown = labels(kept.map(o => o.label), LIMIT.option, notes);
  return {
    title: el.placeholder,
    control: { kind: "select" as const, multiple: !!el.multiple, options },
    build: (title: string, sub?: string) => vote(title, sub, `${el.multiple ? "m" : "s"}.${el.token}`, !!el.multiple, options.map((o, i) => ({ id: o.id, text: shown[i]! })))
  };
}

const vote = (title: string, sub: string | undefined, key: string, multiple: boolean, options: { id: string; text: string }[]) => ({
  card_type: "vote_interaction", ...titled(title, sub),
  checkbox: { question_key: key, mode: multiple ? 1 : 0, option_list: options },
  submit_button: { text: SUBMIT, key: "submit" }
});

/** The press a card callback reports: the IM layer's token, the chosen value(s), and the ids to mark on the card. */
export function controlOf(ev: WCardEvent, known?: Control): { token: string; value?: string | string[]; chosen: string[] } | null {
  const key = ev.event_key ?? "";
  if (key.startsWith("b.") && key.length > 2) return { token: key.slice(2), chosen: [key] };
  if (key !== "submit") return null;
  const item = ev.selected_items?.selected_item?.[0];
  const ids = item?.option_ids?.option_id ?? [];
  const question = item?.question_key ?? "";
  if (question === "a") return ids[0]?.startsWith("b.") ? { token: ids[0].slice(2), chosen: [ids[0]] } : null;
  const m = /^([sm])\.(.+)$/.exec(question);
  if (!m || !ids.length) return null;
  const values = ids.map(id => (id.startsWith("v.") ? id.slice(2) : known?.options.find(o => o.id === id)?.value));
  if (values.some(v => v === undefined)) return null;
  return { token: m[2]!, value: m[1] === "m" ? values as string[] : values[0]!, chosen: ids };
}

/** The card as it stands once answered: the choice shown, nothing left to press. */
export function answeredOf(card: Card, chosen: string[]): Record<string, unknown> {
  const c = structuredClone(card.card);
  if (card.control.kind === "buttons") {
    const label = card.control.options.find(o => o.id === chosen[0])?.label ?? "";
    c.button_list = [{ text: clip(`✓ ${label}`, LIMIT.button), key: "x.done" }];
  } else {
    const box = c.checkbox as { option_list: { id: string }[] };
    c.checkbox = { ...box, disable: true, option_list: box.option_list.map(o => ({ ...o, is_checked: chosen.includes(o.id) })) };
    c.submit_button = { text: "✓", key: "x.done" };
  }
  return c;
}
