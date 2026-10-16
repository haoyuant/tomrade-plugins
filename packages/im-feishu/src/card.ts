import type { ImContent, ImElement } from "@tomradex/plugin-sdk";
import type { FCardAction } from "./wire.js";

/**
 * What a control hands back to the adapter: its kind (`b` a button, `f` a
 * form's submit), the IM layer's token, and the topic the card was posted in
 * (`a`), so a press finds its conversation again after a restart.
 */
export interface Control { k: "b" | "f"; t: string; a?: string }

export const LIMIT = { label: 40, options: 50, optionText: 100, summary: 60 };
/** The markdown element a streaming card writes into. */
export const STREAM_ELEMENT = "md";

const clip = (text: string, n: number) => ([...text].length > n ? `${[...text].slice(0, n - 1).join("")}…` : text);
const plain = (content: string) => ({ tag: "plain_text", content });
const http = (url: string) => /^https?:\/\//i.test(url);
const TYPE = { default: "default", primary: "primary", danger: "danger" } as const;

type Element = Record<string, unknown>;

const callback = (value: Control) => [{ type: "callback", value }];

function button(label: string, type: string, behaviors: unknown[], extra: Element = {}): Element {
  return { tag: "button", text: plain(clip(label, LIMIT.label)), type, behaviors, ...extra };
}

/** Buttons side by side, wrapping onto new lines as the card narrows. */
const row = (buttons: Element[]): Element => ({
  tag: "column_set", flex_mode: "flow", horizontal_spacing: "small",
  columns: buttons.map(b => ({ tag: "column", width: "auto", elements: [b] }))
});

/** A select or a text entry with its own submit button: the answer arrives as one form submission. */
function form(index: number, field: Element, token: string, topic: string | undefined, submit: string): Element {
  return {
    tag: "form", name: `form${index}`,
    elements: [field, button(submit, "primary", callback({ k: "f", t: token, ...(topic ? { a: topic } : {}) }), { name: `submit${index}`, form_action_type: "submit" })]
  };
}

function summaryOf(text: string): string {
  return clip(text.replace(/[#*_`>~[\]()]/g, "").replace(/\s+/g, " ").trim(), LIMIT.summary);
}

/**
 * IM content as a JSON 2.0 card: the text as Markdown, sections as Markdown
 * blocks, buttons and links in a row, and each select or text entry in a
 * form with a submit button. App links (`tomrade://`) are shown as text,
 * since card buttons open web links only.
 */
export function cardOf(content: ImContent, opts: { topic?: string; submit?: string; streaming?: boolean } = {}): Element {
  const elements: Element[] = [];
  if (content.text) elements.push({ tag: "markdown", content: content.text, element_id: STREAM_ELEMENT });
  const buttons: Element[] = [];
  const linkLines: string[] = [];
  const forms: Element[] = [];
  const submit = opts.submit ?? "OK";
  for (const el of content.elements ?? []) add(el);
  function add(el: ImElement) {
    switch (el.type) {
      case "section": {
        const lines = [el.title ? `**${el.title}**` : "", el.text ?? "", ...(el.fields ?? []).map(f => `**${f.label}**: ${f.value}`)].filter(Boolean);
        if (lines.length) elements.push({ tag: "markdown", content: lines.join("\n") });
        return;
      }
      case "links":
        for (const l of el.links) {
          if (http(l.url)) buttons.push(button(l.label, "default", [{ type: "open_url", default_url: l.url }]));
          else linkLines.push(`${l.label}: ${l.url}`);
        }
        return;
      case "select": {
        const options = el.options.slice(0, LIMIT.options).map(o => ({ text: plain(clip(o.label, LIMIT.optionText)), value: o.value }));
        const field: Element = { tag: el.multiple ? "multi_select_static" : "select_static", name: "v", required: true, options,
          ...(el.placeholder ? { placeholder: plain(clip(el.placeholder, LIMIT.optionText)) } : {}) };
        forms.push(form(forms.length, field, el.token, opts.topic, submit));
        return;
      }
      case "input":
        forms.push(form(forms.length, { tag: "input", name: "v", required: true, max_length: 1000, label: plain(clip(el.label, LIMIT.optionText)), label_position: "top",
          ...(el.placeholder ? { placeholder: plain(clip(el.placeholder, LIMIT.optionText)) } : {}) }, el.token, opts.topic, submit));
        return;
    }
  }
  for (const a of content.actions ?? []) buttons.push(button(a.label, TYPE[a.style ?? "default"], callback({ k: "b", t: a.token, ...(opts.topic ? { a: opts.topic } : {}) })));
  if (linkLines.length) elements.push({ tag: "markdown", content: linkLines.join("\n") });
  // Buttons come right under the text so a question's answers sit next to it.
  if (buttons.length) elements.push(row(buttons));
  elements.push(...forms);
  if (!elements.length) elements.push({ tag: "markdown", content: " ", element_id: STREAM_ELEMENT });
  return {
    schema: "2.0",
    config: {
      update_multi: true, width_mode: "fill",
      ...(opts.streaming !== undefined ? { streaming_mode: opts.streaming } : {}),
      ...(opts.streaming ? { streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 2 } } } : {}),
      summary: { content: summaryOf(content.text) || " " }
    },
    body: { elements }
  };
}

/** The control a callback came from, and the answer it carries. */
export function controlOf(action: FCardAction["action"]): { control: Control; value?: string | string[] } | null {
  const v = action.value as Partial<Control> | undefined;
  if (!v || typeof v !== "object" || (v.k !== "b" && v.k !== "f") || typeof v.t !== "string" || !v.t) return null;
  const control: Control = { k: v.k, t: v.t, ...(typeof v.a === "string" && v.a ? { a: v.a } : {}) };
  if (control.k === "b") return { control };
  const raw = action.form_value?.v;
  const value = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw : raw === undefined ? undefined : String(raw);
  return { control, ...(value !== undefined && (typeof value === "string" ? value.trim() : value.length) ? { value } : {}) };
}
