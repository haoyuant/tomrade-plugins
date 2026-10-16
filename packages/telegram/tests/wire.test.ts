import { describe, expect, it } from "vitest";
import { activationOf, addressOf, contextOf, filesOf, readText, type TMessage } from "../src/wire.js";

const bot = { id: 42, username: "Tomrade_Bot" };
const ann = { id: 7, is_bot: false, first_name: "Ann" };
const group = { id: -1001, type: "supergroup" as const };
const msg = (o: Partial<TMessage>): TMessage => ({ message_id: 1, chat: group, date: 1, from: ann, ...o });

describe("reading a message", () => {
  it("drops its own @ in any case, keeps other people's", () => {
    const m = msg({ text: "@tomrade_bot ask @bob please", entities: [{ type: "mention", offset: 0, length: 12 }, { type: "mention", offset: 17, length: 4 }] });
    expect(readText(m, bot)).toEqual({ text: "ask @bob please", mentioned: true, command: null });
  });

  it("knows a mention of a bot without a username link", () => {
    const m = msg({ text: "Tomrade, status?", entities: [{ type: "text_mention", offset: 0, length: 7, user: { id: 42, is_bot: true, first_name: "Tomrade" } }] });
    expect(readText(m, bot)).toMatchObject({ text: ", status?", mentioned: true });
  });

  it("cuts its own name off a command and leaves other bots' commands alone", () => {
    expect(readText(msg({ text: "/answer@Tomrade_Bot abc yes", entities: [{ type: "bot_command", offset: 0, length: 19 }] }), bot)).toEqual({ text: "/answer abc yes", mentioned: false, command: "ours" });
    expect(readText(msg({ text: "/start@other_bot", entities: [{ type: "bot_command", offset: 0, length: 16 }] }), bot).command).toBe("other");
    expect(readText(msg({ text: "see /help", entities: [{ type: "bot_command", offset: 4, length: 5 }] }), bot)).toMatchObject({ text: "see /help", command: null });
  });

  it("reads a caption like text", () => {
    expect(readText(msg({ caption: "@tomrade_bot this one", caption_entities: [{ type: "mention", offset: 0, length: 12 }] }), bot)).toMatchObject({ text: "this one", mentioned: true });
  });

  it("tells how the message reached the bot", () => {
    const read = { mentioned: false, command: null };
    expect(activationOf(msg({ chat: { id: 7, type: "private" } }), bot, read)).toBe("dm");
    expect(activationOf(msg({}), bot, { mentioned: true, command: null })).toBe("mention");
    expect(activationOf(msg({}), bot, { mentioned: false, command: "ours" })).toBe("mention");
    expect(activationOf(msg({ reply_to_message: msg({ from: { id: 42, is_bot: true, first_name: "T" } }) }), bot, read)).toBe("reply");
    expect(activationOf(msg({}), bot, read)).toBe("ambient");
    // A topic's opening is no reply, whoever opened it.
    expect(activationOf(msg({ reply_to_message: msg({ from: { id: 42, is_bot: true, first_name: "T" }, forum_topic_created: { name: "x" } }) }), bot, read)).toBe("ambient");
  });
});

describe("addresses and context", () => {
  it("keeps a forum topic apart, but not a plain group's reply chain", () => {
    expect(addressOf(msg({ message_thread_id: 5, is_topic_message: true }))).toEqual({ tenantId: "telegram", conversationId: "-1001", topicId: "5" });
    expect(addressOf(msg({ message_thread_id: 5 }))).toEqual({ tenantId: "telegram", conversationId: "-1001" });
  });

  it("carries the quoted message, or the topic's name", () => {
    const quoted = msg({ message_id: 9, text: "the plan", from: { id: 8, is_bot: false, first_name: "Bob", last_name: "Wu" } });
    expect(contextOf(msg({ reply_to_message: quoted }), bot)).toEqual([{ role: "quoted", messageId: "9", author: { id: "8", name: "Bob Wu", isBot: false }, text: "the plan" }]);
    expect(contextOf(msg({ reply_to_message: msg({ message_id: 3, forum_topic_created: { name: "Release" } }) }), bot)).toEqual([{ role: "root", messageId: "3", author: { id: "7", name: "Ann", isBot: false }, text: "Release" }]);
  });
});

describe("files", () => {
  it("takes a photo's largest size and names what has no name", () => {
    const m = msg({ message_id: 4, photo: [{ file_id: "s", file_size: 1 }, { file_id: "l", file_size: 9 }], voice: { file_id: "v", file_size: 3, mime_type: "audio/ogg" } });
    expect(filesOf(m)).toEqual([{ id: "l", name: "photo-4.jpg", mimeType: "image/jpeg", size: 9 }, { id: "v", name: "voice-4.ogg", mimeType: "audio/ogg", size: 3 }]);
  });
});
