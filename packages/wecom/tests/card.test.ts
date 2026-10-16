import { describe, expect, it } from "vitest";
import { answeredOf, clipBytes, controlOf, plain, planOf } from "../src/card.js";

const ids = { taskId: (i: number) => `task${i}` };
type Vote = { card_type: string; checkbox: { question_key: string; mode: number; option_list: { id: string; text: string }[] }; submit_button: { key: string } };

describe("plans", () => {
  it("keeps short text in a single card's title and subtitle", () => {
    const plan = planOf({ text: "**Ship it?**\nIt goes out tonight.", actions: [{ label: "Yes", token: "tk1", style: "primary" }, { label: "No", token: "tk2" }] }, ids);
    expect(plan.markdown).toBe("");
    expect(plan.cards[0]!.card).toEqual({ card_type: "button_interaction", main_title: { title: "Ship it?" }, sub_title_text: "It goes out tonight.",
      button_list: [{ text: "Yes", key: "b.tk1" }, { text: "No", key: "b.tk2" }], task_id: "task0" });
  });

  it("puts longer text above the card, which keeps its first line as title", () => {
    const text = `Which database should the import use?\n\n${"Details. ".repeat(30)}`;
    const plan = planOf({ text, actions: [{ label: "Postgres", token: "a" }, { label: "SQLite", token: "b" }] }, ids);
    expect(plan.markdown).toBe(text.trim());
    expect(plan.cards[0]!.card).toMatchObject({ main_title: { title: "Which database should the import use?" } });
    expect(plan.cards[0]!.card).not.toHaveProperty("sub_title_text");
  });

  it("writes sections and links as Markdown, app links as text", () => {
    const plan = planOf({ text: "Created", elements: [{ type: "section", title: "TOM-1 Ship", text: "A ticket", fields: [{ label: "Status", value: "Doing" }] },
      { type: "links", links: [{ label: "Open", url: "https://x.test" }, { label: "App", url: "tomrade://item/1" }] }] }, ids);
    expect(plan).toEqual({ markdown: "Created\n\n**TOM-1 Ship**\nA ticket\n**Status**: Doing\n\n[Open](https://x.test)\nApp: tomrade://item/1", cards: [] });
  });

  it("numbers labels too wide for a card and spells them out", () => {
    const plan = planOf({ text: "Pick", actions: [{ label: "使用现有的数据库结构继续导入", token: "a" }, { label: "OK", token: "b" }] }, ids);
    expect((plan.cards[0]!.card.button_list as { text: string }[]).map(b => b.text)).toEqual(["1. 使用现有的数据库…", "2. OK"]);
    expect(plan.markdown).toBe("Pick\n\n1. 使用现有的数据库结构继续导入\n2. OK");
  });

  it("makes more than six buttons a single-choice vote", () => {
    const actions = Array.from({ length: 8 }, (_, i) => ({ label: `Option ${i}`, token: `t${i}` }));
    const card = planOf({ text: "Choose", actions }, ids).cards[0]!.card as Vote;
    expect(card.card_type).toBe("vote_interaction");
    expect(card.checkbox).toMatchObject({ question_key: "a", mode: 0 });
    expect(card.checkbox.option_list.map(o => o.id)).toEqual(actions.map(a => `b.${a.token}`));
  });

  it("makes each select a vote card: plain values ride in the option ids, the rest by index", () => {
    const plan = planOf({ text: "Settings", elements: [
      { type: "select", token: "s1", placeholder: "Agent", options: [{ label: "Claude Code", value: "claude-code" }, { label: "Codex", value: "codex" }] },
      { type: "select", token: "s2", multiple: true, options: [{ label: "A", value: "a b" }, { label: "B", value: "a b" }] }] }, ids);
    expect(plan.cards).toHaveLength(2);
    const [one, two] = plan.cards.map(c => c.card as Vote);
    expect(one).toMatchObject({ card_type: "vote_interaction", checkbox: { question_key: "s.s1", mode: 0, option_list: [{ id: "v.claude-code", text: "Claude Code" }, { id: "v.codex" }] }, submit_button: { key: "submit" } });
    expect(two!.checkbox).toMatchObject({ question_key: "m.s2", mode: 1, option_list: [{ id: "o0" }, { id: "o1" }] });
    expect(plan.markdown).toBe("Settings");
  });

  it("sends options past twenty as /answer lines", () => {
    const options = Array.from({ length: 24 }, (_, i) => ({ label: `S${i}`, value: `${i}` }));
    const plan = planOf({ text: "Sessions", elements: [{ type: "select", token: "tk", options }] }, ids);
    expect((plan.cards[0]!.card as Vote).checkbox.option_list).toHaveLength(20);
    expect(plan.markdown).toBe("Sessions\n\nS20: /answer tk 20\nS21: /answer tk 21\nS22: /answer tk 22\nS23: /answer tk 23");
  });

  it("keeps the text out of the card when it fills a stream", () => {
    const plan = planOf({ text: "Ship it?", actions: [{ label: "Yes", token: "tk" }] }, { ...ids, markdown: true });
    expect(plan.markdown).toBe("Ship it?");
    expect(plan.cards[0]!.card).toMatchObject({ main_title: { title: "Ship it?" } });
  });
});

describe("callbacks", () => {
  it("reads a button, a choice and a select back", () => {
    expect(controlOf({ event_key: "b.tk1" })).toEqual({ token: "tk1", chosen: ["b.tk1"] });
    expect(controlOf({ event_key: "submit", selected_items: { selected_item: [{ question_key: "a", option_ids: { option_id: ["b.t3"] } }] } })).toEqual({ token: "t3", chosen: ["b.t3"] });
    const known = { kind: "select" as const, options: [{ id: "o0", label: "A", value: "a b" }] };
    expect(controlOf({ event_key: "submit", selected_items: { selected_item: [{ question_key: "m.tk", option_ids: { option_id: ["v.x", "o0"] } }] } }, known))
      .toEqual({ token: "tk", value: ["x", "a b"], chosen: ["v.x", "o0"] });
    expect(controlOf({ event_key: "submit", selected_items: { selected_item: [{ question_key: "s.tk", option_ids: { option_id: ["v.x"] } }] } })).toMatchObject({ token: "tk", value: "x" });
  });

  it("ignores what it cannot read", () => {
    expect(controlOf({ event_key: "submit", selected_items: { selected_item: [{ question_key: "s.tk", option_ids: { option_id: ["o3"] } }] } })).toBeNull();
    expect(controlOf({ event_key: "x.done" })).toBeNull();
    expect(controlOf({ event_key: "other_app_key" })).toBeNull();
  });

  it("shows the answer on the card and leaves nothing to press", () => {
    const plan = planOf({ text: "Ship it?", actions: [{ label: "Yes", token: "y" }, { label: "No", token: "n" }] }, ids);
    expect(answeredOf(plan.cards[0]!, ["b.n"])).toMatchObject({ main_title: { title: "Ship it?" }, button_list: [{ text: "✓ No", key: "x.done" }], task_id: "task0" });
    const vote = planOf({ text: "Pick", elements: [{ type: "select", token: "s", multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] }, ids).cards[0]!;
    expect(answeredOf(vote, ["v.b"])).toMatchObject({ checkbox: { disable: true, option_list: [{ id: "v.a", is_checked: false }, { id: "v.b", is_checked: true }] }, submit_button: { text: "✓" } });
    expect((vote.card.checkbox as { disable?: boolean }).disable).toBeUndefined();
  });
});

describe("text", () => {
  it("fits WeCom's 20480 bytes without splitting a character", () => {
    const clipped = clipBytes("长".repeat(7000));
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(20_480);
    expect(clipped.endsWith("长…")).toBe(true);
    expect(clipBytes("short")).toBe("short");
  });

  it("reads Markdown as plain text for a card", () => {
    expect(plain("## **Plan**\n> see [the doc](https://x.test) and `code`")).toBe("Plan\nsee the doc and code");
  });
});
