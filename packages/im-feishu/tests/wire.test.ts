import { describe, expect, it } from "vitest";
import { addressOf, fileId, menuCommand, parseFileId, parseMessage, type FMessage } from "../src/wire.js";

const msg = (o: Partial<FMessage>): FMessage => ({ message_id: "om_1", chat_id: "oc_1", chat_type: "group", message_type: "text", content: "{}", ...o });
const bot = "ou_bot";

describe("inbound messages", () => {
  it("drops the bot's own @ and spells out other people's", () => {
    const p = parseMessage(msg({ content: JSON.stringify({ text: "@_user_1 ask @_user_2 about it" }),
      mentions: [{ key: "@_user_1", id: { open_id: bot }, name: "Tomrade" }, { key: "@_user_2", id: { open_id: "ou_ann" }, name: "Ann" }] }), bot);
    expect(p).toEqual({ text: "ask @Ann about it", mentioned: true, files: [] });
  });

  it("is not a mention when only someone else is @'d", () => {
    expect(parseMessage(msg({ content: JSON.stringify({ text: "@_user_1 hi" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_ann" }, name: "Ann" }] }), bot).mentioned).toBe(false);
  });

  it("reads a post's paragraphs, links, code and images", () => {
    const content = { title: "Plan", content: [
      [{ tag: "at", user_id: "@_user_1", user_name: "Tomrade" }, { tag: "text", text: " see " }, { tag: "a", text: "spec", href: "https://x.test/s" }],
      [{ tag: "img", image_key: "img_1" }],
      [{ tag: "code_block", language: "ts", text: "let a = 1" }]
    ] };
    const p = parseMessage(msg({ message_type: "post", content: JSON.stringify(content), mentions: [{ key: "@_user_1", id: { open_id: bot }, name: "Tomrade" }] }), bot);
    expect(p.mentioned).toBe(true);
    expect(p.text).toBe("Plan\nsee [spec](https://x.test/s)\n```ts\nlet a = 1\n```");
    expect(p.files).toEqual([{ key: "img_1", type: "image" }]);
  });

  it("reads a post wrapped in a locale", () => {
    expect(parseMessage(msg({ message_type: "post", content: JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "text", text: "你好" }]] } }) }), bot).text).toBe("你好");
  });

  it("carries images and files as files", () => {
    expect(parseMessage(msg({ message_type: "image", content: JSON.stringify({ image_key: "img_9" }) }), bot).files).toEqual([{ key: "img_9", type: "image" }]);
    expect(parseMessage(msg({ message_type: "file", content: JSON.stringify({ file_key: "file_9", file_name: "a.pdf" }) }), bot).files).toEqual([{ key: "file_9", type: "file", name: "a.pdf" }]);
  });

  it("puts a message written in a topic under the topic's first message", () => {
    expect(addressOf("t", msg({ thread_id: "omt_1", root_id: "om_root", message_id: "om_2" }))).toEqual({ tenantId: "t", conversationId: "oc_1", topicId: "om_root" });
    expect(addressOf("t", msg({ root_id: "om_root", parent_id: "om_root" }))).toEqual({ tenantId: "t", conversationId: "oc_1" });
  });

  it("names files and menu commands", () => {
    const id = fileId("om_1", { key: "img_1", type: "image" });
    expect(parseFileId(id)).toEqual({ messageId: "om_1", type: "image", key: "img_1" });
    expect(parseFileId("nonsense")).toBeNull();
    expect(menuCommand("new")).toBe("/new");
    expect(menuCommand("/stop")).toBe("/stop");
  });
});
