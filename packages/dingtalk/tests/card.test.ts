import { describe, expect, it } from "vitest";
import { forCard, markdownOf, MAX_BUTTONS, paramsOf, tokenOf } from "../src/card.js";

describe("forCard", () => {
  it("breaks single lines with <br>, but keeps code, lists, quotes and paragraphs", () => {
    expect(forCard("a\nb\n\nc\n- one\n- two\n```ts\nx\ny\n```\nd\n> q")).toBe("a<br>b\n\nc\n- one\n- two\n```ts\nx\ny\n```\nd\n> q");
  });

  it("gives a table the blank line DingTalk needs", () => {
    expect(forCard("Results:\n| a | b |\n| - | - |\n| 1 | 2 |")).toBe("Results:\n\n| a | b |\n| - | - |\n| 1 | 2 |");
  });
});

describe("paramsOf", () => {
  it("sets the shown field, the status and the buttons, clearing the other field", () => {
    const actions = Array.from({ length: MAX_BUTTONS + 1 }, (_, i) => ({ label: `Option ${i} with a rather long label`, token: `t${i}` }));
    const p = paramsOf({ text: "Pick", actions }, "3", "staticMsgContent");
    expect(p).toMatchObject({ flowStatus: "3", msgContent: "", staticMsgContent: "Pick\n\nOption 6 with a rather long label：/answer t6" });
    const obj = JSON.parse(p.sys_full_json_obj!) as { order: string[]; msgButtons: { text: string; id: string }[] };
    expect(obj.order).toEqual(["staticMsgContent", "msgButtons"]);
    expect(obj.msgButtons).toHaveLength(MAX_BUTTONS);
    expect(obj.msgButtons[0]).toEqual({ text: "Option 0 with a rat…", id: "t0", color: "blue", request: true });
  });

  it("clears the buttons when content has none", () => {
    expect(JSON.parse(paramsOf({ text: "done" }, "3", "msgContent").sys_full_json_obj!)).toEqual({ order: ["msgContent", "msgButtons"], msgButtons: [] });
  });
});

describe("markdownOf", () => {
  it("writes every button as an /answer line where nothing can be pressed", () => {
    expect(markdownOf({ text: "Ship?", actions: [{ label: "Yes", token: "a" }, { label: "No", token: "b" }] })).toBe("Ship?\n\nYes：/answer a\nNo：/answer b");
  });
});

describe("tokenOf", () => {
  it("reads the pressed button's id from the callback content", () => {
    expect(tokenOf(JSON.stringify({ cardPrivateData: { actionIds: ["tk-1"], params: {} } }))).toBe("tk-1");
    expect(tokenOf({ cardPrivateData: { params: { id: "tk-2" } } })).toBe("tk-2");
    expect(tokenOf("{}")).toBeNull();
  });
});
