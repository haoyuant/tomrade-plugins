import { describe, expect, it } from "vitest";
import { splitImText } from "@tomradex/plugin-sdk";
import { Codec, plainOf, readSelect, render, retick, visible } from "../src/markup.js";
import { parseHtml } from "../src/fake.js";

const token = "0123456789abcdef".repeat(3);

describe("callback data", () => {
  it("packs the IM layer's hex token into 64 bytes and back", () => {
    const codec = new Codec();
    for (const [kind, index] of [["b", undefined], ["o", 23], ["m", 7], ["M", undefined], ["i", undefined]] as const) {
      const data = codec.pack(kind, token, index);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(codec.unpack(data)).toEqual({ kind, token, ...(index !== undefined ? { index } : {}) });
    }
    expect(codec.pack("b", token)).toHaveLength(33);
  });

  it("keeps other tokens as they are, or as an alias when too long", () => {
    const codec = new Codec();
    expect(codec.unpack(codec.pack("o", "start-set:engine.v2", 1))).toEqual({ kind: "o", token: "start-set:engine.v2", index: 1 });
    const long = "x".repeat(80);
    const data = codec.pack("m", long, 3);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(codec.unpack(data)).toEqual({ kind: "m", token: long, index: 3 });
    expect(new Codec().unpack(data)).toBeNull();
  });

  it("reads nothing from data that is not its own", () => {
    const codec = new Codec();
    expect(codec.unpack("hello")).toBeNull();
    expect(codec.unpack("o~abc")).toBeNull();
    expect(codec.unpack("x")).toEqual({ kind: "x", token: "" });
  });
});

describe("render", () => {
  it("lays out buttons, selects, a written answer and links", () => {
    const codec = new Codec();
    const r = render({ text: "<b>Pick</b>", actions: [{ label: "Yes", token, style: "primary" }, { label: "No", token, style: "danger" }],
      elements: [{ type: "select", token, multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
        { type: "input", token, label: "Your answer" }, { type: "links", links: [{ label: "Docs", url: "https://x.test" }] }] }, codec);
    expect(r.text).toBe("<b>Pick</b>");
    expect(r.keyboard!.inline_keyboard.map(row => row.map(b => b.text))).toEqual([["Yes", "No"], ["A", "B"], ["Submit"], ["✍️ Your answer"], ["Docs"]]);
    expect(r.keyboard!.inline_keyboard[0]!.map(b => b.style)).toEqual(["primary", "danger"]);
    expect(codec.unpack(r.keyboard!.inline_keyboard[1]![1]!.callback_data!)).toEqual({ kind: "m", token, index: 1 });
  });

  it("speaks Chinese on its own buttons when the card does", () => {
    const r = render({ text: "选哪些？", elements: [{ type: "select", token, multiple: true, options: [{ label: "甲", value: "a" }] }] }, new Codec());
    expect(r.keyboard!.inline_keyboard.at(-1)![0]!.text).toBe("确定");
  });

  it("puts long labels on rows of their own", () => {
    const r = render({ text: "Which conversation?", elements: [{ type: "select", token, options: [{ label: "Planning the next release with the team", value: "1" }, { label: "Short", value: "2" }, { label: "Tiny", value: "3" }] }] }, new Codec());
    expect(r.keyboard!.inline_keyboard.map(row => row.length)).toEqual([1, 2]);
  });

  it("gives a card with no text something to show", () => {
    expect(render({ text: "", elements: [{ type: "select", token, placeholder: "Model", options: [{ label: "a", value: "a" }] }] }, new Codec()).text).toBe("Model");
    expect(render({ text: "" }, new Codec()).text).toBe("…");
  });

  it("cuts extras short at Telegram's limit, never the text", () => {
    const text = "x".repeat(4000);
    const r = render({ text, elements: [{ type: "section", title: "A", text: "y".repeat(50) }, { type: "section", title: "B", text: "z".repeat(200) }] }, new Codec());
    expect(r.text.startsWith(text)).toBe(true);
    expect(visible(r.text)).toBeLessThanOrEqual(4096);
    expect(plainOf(r.text)).toContain("y".repeat(50));
    expect(r.text.endsWith("\n…")).toBe(true);
  });

  it("writes only HTML Telegram parses, from the common layer's Markdown", () => {
    const md = "# Plan\n**bold** _it_ ~~gone~~ `a<b` [link](https://x.test?a=1&b=2) [app](tomrade://item/p/TOM-1)\n> quoted\n```ts\nif (a < b && c) {}\n```";
    for (const chunk of splitImText(md, 4096, "telegram-html")) {
      const r = render({ text: chunk, elements: [{ type: "section", title: "A <b>", text: md, fields: [{ label: "x&y", value: "<z>" }] }] }, new Codec());
      const parsed = parseHtml(r.text);
      expect(parsed).not.toHaveProperty("error");
      expect((parsed as { text: string }).text).toContain("if (a < b && c) {}");
      expect(r.text).not.toContain("tomrade://item/p/TOM-1\"");
    }
  });
});

describe("multi-select keyboards", () => {
  it("ticks options and reads them back", () => {
    const codec = new Codec();
    const { keyboard } = render({ text: "Which?", elements: [{ type: "select", token, multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] }, codec);
    const ticked = retick(keyboard!, codec, token, new Set([1]));
    expect(ticked.inline_keyboard[0]!.map(b => b.text)).toEqual(["A", "✅ B"]);
    expect(readSelect(ticked, codec, token)).toEqual({ picked: new Set([1]), labels: new Map([[0, "A"], [1, "B"]]) });
    expect(retick(ticked, codec, token, new Set([0])).inline_keyboard[0]!.map(b => b.text)).toEqual(["✅ A", "B"]);
    // Another select's toggles are left alone.
    expect(retick(ticked, codec, "ff".repeat(24), new Set([0]))).toEqual(ticked);
  });
});
