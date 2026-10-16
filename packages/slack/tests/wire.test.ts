import { describe, expect, it } from "vitest";
import { addressOf, commandText, mentions, messageId, textOf, threadOf, tsOf, usersIn } from "../src/wire.js";

describe("addresses", () => {
  it("makes a direct message's thread its own conversation, and a channel one conversation", () => {
    expect(addressOf("T1", "D1", "1.1", undefined)).toEqual({ tenantId: "T1", conversationId: "D1", topicId: "1.1" });
    expect(addressOf("T1", "D1", "1.2", "1.1")).toEqual({ tenantId: "T1", conversationId: "D1", topicId: "1.1" });
    expect(addressOf("T1", "D1", undefined, undefined)).toEqual({ tenantId: "T1", conversationId: "D1" });
    expect(addressOf("T1", "C1", "1.2", "1.1")).toEqual({ tenantId: "T1", conversationId: "C1" });
  });

  it("keeps a message's thread in its id", () => {
    expect(messageId("1.2", "1.1")).toBe("1.2@1.1");
    expect(messageId("1.1", "1.1")).toBe("1.1");
    expect([threadOf("1.2@1.1"), threadOf("1.1"), threadOf("cmd:x"), threadOf("stop:1.3@1.1"), threadOf(undefined)]).toEqual(["1.1", "1.1", undefined, "1.1", undefined]);
    expect([tsOf("1.2@1.1"), tsOf("cmd:x"), tsOf("file:F1")]).toEqual(["1.2", undefined, undefined]);
  });
});

describe("text", () => {
  it("reads a message as the Agent should", () => {
    const text = "<@U0BOT> ask <@U0BOB> in <#C1|dev> about <https://x.test|this> &amp; <https://y.test> <!here> <!subteam^S1|@eng> a &lt; b";
    expect(usersIn(text)).toEqual(["U0BOT", "U0BOB"]);
    expect(mentions(text, "U0BOT")).toBe(true);
    expect(mentions(text, "U0ZED")).toBe(false);
    expect(textOf(text, "U0BOT", id => (id === "U0BOB" ? "Bob" : undefined))).toBe("ask @Bob in #dev about [this](https://x.test) & https://y.test @here @eng a < b");
  });
});

describe("commands", () => {
  it("runs a known command and says anything else", () => {
    expect(commandText("status")).toBe("/status");
    expect(commandText("  /Stop ")).toBe("/stop");
    expect(commandText("steer  look at line 3")).toBe("/steer  look at line 3");
    expect(commandText("")).toBe("/help");
    expect(commandText("pair 123456")).toBe("/pair 123456");
    expect(commandText("what is left?")).toBe("what is left?");
  });
});
