import { describe, expect, it } from "vitest";
import { toImDialect } from "@tomradex/plugin-sdk";
import { controlOf, markdownOf, messageOf } from "../src/blocks.js";

describe("messages", () => {
  it("writes text, buttons with styles, and clips labels to Slack's limits", () => {
    const { text, blocks } = messageOf({ text: "*Ship it?*", actions: [{ label: "Yes", token: "t1", style: "primary" }, { label: "x".repeat(100), token: "t2", style: "default" }] });
    expect(text).toBe("*Ship it?*");
    expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "*Ship it?*" } });
    const [yes, long] = (blocks[1] as { elements: Record<string, unknown>[] }).elements;
    expect(yes).toMatchObject({ type: "button", value: "t1", style: "primary", action_id: "tomrade:b:0" });
    expect(long).not.toHaveProperty("style");
    expect([...(long!.text as { text: string }).text]).toHaveLength(75);
  });

  it("converts a section's Markdown and escapes its plain parts", () => {
    const { blocks } = messageOf({ text: "", elements: [{ type: "section", title: "A & B", text: "**bold** and [link](https://x.test)", fields: [{ label: "<k>", value: "v" }] }] });
    expect(blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: `*A &amp; B*\n${toImDialect("**bold** and [link](https://x.test)", "slack")}` }, fields: [{ type: "mrkdwn", text: "*&lt;k&gt;*\nv" }] }]);
  });

  it("puts a multi-select and a text entry in input blocks with a submit button, in the message's language", () => {
    const { blocks, choices } = messageOf({ text: "选一个", elements: [
      { type: "select", token: "m1", multiple: true, options: [{ label: "A", value: "a" }] },
      { type: "input", token: "i1", label: "其他" }] });
    expect(blocks.slice(1)).toMatchObject([
      { type: "input", block_id: "tomrade:f:m1", label: { text: "请选择" }, element: { type: "multi_static_select", action_id: "v", options: [{ value: "a" }] } },
      { type: "actions", elements: [{ type: "button", action_id: "tomrade:f", value: "m1", text: { text: "提交" } }] },
      { type: "input", block_id: "tomrade:f:i1", label: { text: "其他" }, element: { type: "plain_text_input", action_id: "v", multiline: true } },
      { type: "actions", elements: [{ type: "button", value: "i1" }] }
    ]);
    expect(choices).toEqual([]);
  });

  it("never sends more than fifty blocks", () => {
    const elements = Array.from({ length: 60 }, (_, i) => ({ type: "section" as const, title: `T${i}` }));
    expect(messageOf({ text: "many", elements }).blocks).toHaveLength(50);
  });
});

describe("controls", () => {
  it("reads back a button, a select and a form", () => {
    expect(controlOf({ action_id: "tomrade:b:0", block_id: "x", type: "button", value: "t1" }, undefined)).toEqual({ token: "t1" });
    expect(controlOf({ action_id: "tomrade:s", block_id: "tomrade:s:s1", type: "static_select", selected_option: { value: "#2" } }, undefined, () => ["a", "b", "long"])).toEqual({ token: "s1", value: "long" });
    expect(controlOf({ action_id: "tomrade:s", block_id: "tomrade:s:s1", type: "static_select", selected_option: { value: "#2" } }, undefined)).toEqual({ token: "s1", value: "#2" });
    expect(controlOf({ action_id: "tomrade:f", block_id: "b", type: "button", value: "f1" }, { "tomrade:f:f1": { v: { type: "plain_text_input", value: "  " } } })).toEqual({ token: "f1" });
    expect(controlOf({ action_id: "tomrade:l:0", block_id: "b", type: "button" }, undefined)).toBeNull();
    expect(controlOf({ action_id: "other_app", block_id: "b", type: "button", value: "x" }, undefined)).toBeNull();
  });
});

describe("streamed Markdown", () => {
  it("turns mrkdwn into the Markdown the streaming methods read", () => {
    const md = toImDialect("**Plan** for `a < b`:\n- step _one_ ~~old~~\n```\nif (a && b) {}\n```\nSee [the guide](https://x.test/g) or <https://x.test/a_(b)>.", "slack");
    expect(markdownOf(md)).toBe("**Plan** for `a < b`:\n• step _one_ ~~old~~\n```\nif (a && b) {}\n```\nSee [the guide](https://x.test/g) or [https://x.test/a_(b)](https://x.test/a_%28b%29).");
  });

  it("only ever extends what it already gave", () => {
    const md = toImDialect("Hi **there**, see <https://x.test> and `x &amp; y` then\n```\n<a> & b\n```\ndone", "slack");
    let before = "";
    for (let n = 1; n <= md.length; n++) {
      const now = markdownOf(md.slice(0, n));
      expect(now.startsWith(before), `at ${n}: ${JSON.stringify(now)} after ${JSON.stringify(before)}`).toBe(true);
      before = now;
    }
  });
});
