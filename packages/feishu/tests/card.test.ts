import { describe, expect, it } from "vitest";
import { cardOf, controlOf } from "../src/card.js";

type Card = { config: Record<string, unknown>; body: { elements: Record<string, unknown>[] } };

describe("cards", () => {
  it("writes text, sections, buttons and links", () => {
    const card = cardOf({ text: "**Ship it?**", actions: [{ label: "Yes", token: "tk1", style: "primary" }],
      elements: [{ type: "section", title: "TOM-1", text: "A ticket", fields: [{ label: "Status", value: "Doing" }] },
        { type: "links", links: [{ label: "Open", url: "https://x.test" }, { label: "App", url: "tomrade://item/1" }] }] }, { topic: "om_root" }) as Card;
    expect(card.config).toMatchObject({ update_multi: true, summary: { content: "Ship it?" } });
    const [text, section, links, row] = card.body.elements;
    expect(text).toMatchObject({ tag: "markdown", content: "**Ship it?**", element_id: "md" });
    expect(section).toMatchObject({ tag: "markdown", content: "**TOM-1**\nA ticket\n**Status**: Doing" });
    expect(links).toMatchObject({ tag: "markdown", content: "App: tomrade://item/1" });
    const buttons = (row!.columns as { elements: Record<string, unknown>[] }[]).map(c => c.elements[0]!);
    expect(buttons[0]).toMatchObject({ tag: "button", behaviors: [{ type: "open_url", default_url: "https://x.test" }] });
    expect(buttons[1]).toMatchObject({ tag: "button", type: "primary", behaviors: [{ type: "callback", value: { k: "b", t: "tk1", a: "om_root" } }] });
  });

  it("puts selects and text entries in forms", () => {
    const card = cardOf({ text: "Pick", elements: [
      { type: "select", token: "s1", multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
      { type: "input", token: "i1", label: "Other" }] }, { submit: "确定" }) as Card;
    const forms = card.body.elements.filter(e => e.tag === "form") as { name: string; elements: Record<string, unknown>[] }[];
    expect(forms.map(f => f.name)).toEqual(["form0", "form1"]);
    expect(forms[0]!.elements[0]).toMatchObject({ tag: "multi_select_static", name: "v" });
    expect(forms[0]!.elements[1]).toMatchObject({ tag: "button", form_action_type: "submit", text: { content: "确定" }, behaviors: [{ type: "callback", value: { k: "f", t: "s1" } }] });
    expect(forms[1]!.elements[0]).toMatchObject({ tag: "input", name: "v" });
  });

  it("marks a streaming card", () => {
    expect((cardOf({ text: "…" }, { streaming: true }) as Card).config).toMatchObject({ streaming_mode: true });
  });

  it("reads back what a control carries", () => {
    expect(controlOf({ value: { k: "b", t: "tk1", a: "om_1" } })).toEqual({ control: { k: "b", t: "tk1", a: "om_1" } });
    expect(controlOf({ value: { k: "f", t: "s1" }, form_value: { v: ["a", "b"] } })).toEqual({ control: { k: "f", t: "s1" }, value: ["a", "b"] });
    expect(controlOf({ value: { k: "f", t: "i1" }, form_value: { v: "  " } })).toEqual({ control: { k: "f", t: "i1" } });
    expect(controlOf({ value: { action: "other app" } })).toBeNull();
  });
});
