import { toImDialect, type ImContent, type ImElement } from "@tomradex/plugin-sdk";
import type { SAction, SState } from "./wire.js";

/** Block Kit's limits, as far as these messages reach them. */
export const LIMIT = { text: 3000, field: 2000, fields: 10, buttons: 25, label: 75, options: 100, value: 150, placeholder: 150, inputLabel: 2000, input: 3000, blocks: 50 };

export type Block = Record<string, unknown>;

const clip = (text: string, n: number) => ([...text].length > n ? `${[...text].slice(0, n - 1).join("")}…` : text);
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const http = (url: string) => /^https?:\/\//i.test(url);
/** Plain text written into mrkdwn. */
export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Words on controls, in the language the message is written in. */
const words = (sample: string) => (/[\u3400-\u9fff]/.test(sample) ? { submit: "提交", choose: "请选择" } : { submit: "Submit", choose: "Choose" });

/** An option's value as Slack carries it: itself, or its place among the options when longer than Slack takes. */
const optionValue = (value: string, i: number) => (value.length <= LIMIT.value ? value : `#${i}`);

/**
 * IM content as a Block Kit message: the text as an mrkdwn section, sections
 * with their fields, web links and buttons in a row, a single select that
 * answers as soon as it is chosen, and a multi-select or text entry as an
 * input block with a submit button, whose press carries the message's state.
 * App links (`tomrade://`) are shown as text, since buttons open web links
 * only. `choices` are the selects whose values had to go by place.
 */
export function messageOf(content: ImContent): { text: string; blocks: Block[]; choices: [string, string[]][] } {
  const blocks: Block[] = [];
  const buttons: Block[] = [];
  const controls: Block[] = [];
  const appLinks: string[] = [];
  const choices: [string, string[]][] = [];
  const w = words(content.text);
  let summary = content.text;
  if (content.text.trim()) blocks.push({ type: "section", text: mrkdwn(content.text) });
  for (const el of content.elements ?? []) add(el);
  function add(el: ImElement) {
    switch (el.type) {
      case "section": {
        const text = [el.title ? `*${escape(el.title)}*` : "", el.text ? toImDialect(el.text, "slack") : ""].filter(Boolean).join("\n");
        const fields = (el.fields ?? []).slice(0, LIMIT.fields).map(f => mrkdwn(clip(`*${escape(f.label)}*\n${escape(f.value)}`, LIMIT.field)));
        if (text || fields.length) blocks.push({ type: "section", ...(text ? { text: mrkdwn(clip(text, LIMIT.text)) } : {}), ...(fields.length ? { fields } : {}) });
        summary ||= el.title ?? "";
        return;
      }
      case "links":
        for (const l of el.links) {
          if (http(l.url)) buttons.push({ type: "button", text: plain(clip(l.label, LIMIT.label)), url: l.url, action_id: `tomrade:l:${buttons.length}` });
          else appLinks.push(`${escape(l.label)}: ${escape(l.url)}`);
        }
        return;
      case "select": {
        const shown = el.options.slice(0, LIMIT.options);
        if (shown.some(o => o.value.length > LIMIT.value)) choices.push([el.token, shown.map(o => o.value)]);
        const options = shown.map((o, i) => ({ text: plain(clip(o.label, LIMIT.label)), value: optionValue(o.value, i) }));
        const placeholder = plain(clip(el.placeholder || w.choose, LIMIT.placeholder));
        if (el.multiple) controls.push(...form(el.token, plain(clip(el.placeholder || w.choose, LIMIT.inputLabel)), { type: "multi_static_select", action_id: "v", placeholder, options }));
        else controls.push({ type: "actions", block_id: `tomrade:s:${el.token}`, elements: [{ type: "static_select", action_id: "tomrade:s", placeholder, options }] });
        return;
      }
      case "input":
        controls.push(...form(el.token, plain(clip(el.label, LIMIT.inputLabel)), { type: "plain_text_input", action_id: "v", multiline: true, max_length: LIMIT.input,
          ...(el.placeholder ? { placeholder: plain(clip(el.placeholder, LIMIT.placeholder)) } : {}) }));
        return;
    }
  }
  /** An input block and its submit button; the button carries the token, the block holds the answer. */
  function form(token: string, label: Block, element: Block): Block[] {
    return [{ type: "input", block_id: `tomrade:f:${token}`, label, element },
      { type: "actions", elements: [{ type: "button", style: "primary", text: plain(w.submit), action_id: "tomrade:f", value: token }] }];
  }
  for (const a of content.actions ?? []) {
    buttons.push({ type: "button", text: plain(clip(a.label, LIMIT.label)), action_id: `tomrade:b:${buttons.length}`, value: a.token,
      ...(a.style === "primary" || a.style === "danger" ? { style: a.style } : {}) });
  }
  if (appLinks.length) blocks.push({ type: "context", elements: [mrkdwn(clip(appLinks.join("\n"), LIMIT.text))] });
  // Buttons come right under the text so a question's answers sit next to it.
  for (let i = 0; i < buttons.length; i += LIMIT.buttons) blocks.push({ type: "actions", elements: buttons.slice(i, i + LIMIT.buttons) });
  blocks.push(...controls);
  return { text: clip(summary.trim() || "…", LIMIT.text), blocks: blocks.slice(0, LIMIT.blocks), choices };
}

/**
 * The control a press came from and what it answers: a button's own token, a
 * select's choice, or what a form's input block held when its submit button
 * was pressed. Link buttons and other apps' controls give nothing.
 */
export function controlOf(action: SAction, state: SState | undefined, choices: (token: string) => string[] | undefined = () => undefined): { token: string; value?: string | string[] } | null {
  const kind = /^tomrade:([bsf])(?::|$)/.exec(action.action_id)?.[1];
  const decode = (token: string, v: string) => { const at = /^#(\d+)$/.exec(v); return (at && choices(token)?.[Number(at[1])]) ?? v; };
  if (kind === "b") return action.value ? { token: action.value } : null;
  if (kind === "s") {
    const token = action.block_id.startsWith("tomrade:s:") ? action.block_id.slice("tomrade:s:".length) : "";
    const v = action.selected_option?.value;
    return token ? { token, ...(v !== undefined ? { value: decode(token, v) } : {}) } : null;
  }
  if (kind === "f" && action.value) {
    const token = action.value;
    const field = state?.[`tomrade:f:${token}`]?.v;
    const raw = field?.selected_options ? field.selected_options.map(o => decode(token, o.value)) : field?.value ?? undefined;
    const value = typeof raw === "string" ? (raw.trim() ? raw : undefined) : raw?.length ? raw : undefined;
    return { token, ...(value !== undefined ? { value } : {}) };
  }
  return null;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/**
 * mrkdwn as the Markdown Slack's streaming methods read: emphasis doubled,
 * links in brackets, entities decoded inside code. A link or entity still
 * being written is held back, so a longer text only ever extends the result
 * and each append is the difference. The settled message is mrkdwn again.
 */
export function markdownOf(s: string): string {
  let out = "";
  let code: string | null = null;
  for (let i = 0; i < s.length;) {
    if (s[i] === "`") {
      // A run opens code; inside, only the same run closes it and a shorter one is content.
      const run: string = code ?? (s.startsWith("```", i) ? "```" : s.startsWith("``", i) ? "``" : "`");
      const closes: boolean = code !== null && s.startsWith(code, i);
      if (code === null || closes) { out += run; i += run.length; code = closes ? null : run; continue; }
      out += "`";
      i++;
      continue;
    }
    if (code !== null) {
      if (s[i] === "&") {
        const entity = /^&(?:amp|lt|gt);/.exec(s.slice(i, i + 5))?.[0];
        if (entity) { out += ENTITIES[entity]; i += entity.length; continue; }
        if (/^&[a-z]{0,3}$/.test(s.slice(i))) break;
      }
      out += s[i++];
      continue;
    }
    if (s[i] === "<") {
      const close = s.indexOf(">", i);
      if (close < 0) break;
      const inner = s.slice(i + 1, close);
      const bar = inner.indexOf("|");
      const url = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? url : inner.slice(bar + 1);
      out += `[${label.replace(/[[\]]/g, "\\$&")}](${url.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)})`;
      i = close + 1;
      continue;
    }
    out += s[i] === "*" ? "**" : s[i] === "~" ? "~~" : s[i];
    i++;
  }
  return out;
}
