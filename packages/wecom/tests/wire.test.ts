import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, fileName, parseMessage, quoteText, sniff, withoutMention, type WMessage } from "../src/wire.js";

const base = { msgid: "m1", aibotid: "bot", from: { userid: "ann" } };

describe("messages", () => {
  it("reads text, voice, mixed and media messages", () => {
    expect(parseMessage({ ...base, chattype: "single", msgtype: "text", text: { content: " hi " } })).toEqual({ text: "hi", files: [] });
    expect(parseMessage({ ...base, chattype: "single", msgtype: "voice", voice: { content: "语音转的文字" } }).text).toBe("语音转的文字");
    const mixed: WMessage = { ...base, chatid: "g", chattype: "group", msgtype: "mixed", mixed: { msg_item: [
      { msgtype: "text", text: { content: "@Bot look" } }, { msgtype: "image", image: { url: "https://x/1", aeskey: "k" } }, { msgtype: "text", text: { content: "and this" } }] } };
    expect(parseMessage(mixed)).toEqual({ text: "look\nand this", files: [{ url: "https://x/1", aeskey: "k", type: "image" }] });
    expect(parseMessage({ ...base, chattype: "single", msgtype: "file", file: { url: "https://x/2", aeskey: "k2" } }).files).toEqual([{ url: "https://x/2", aeskey: "k2", type: "file" }]);
    expect(parseMessage({ ...base, chattype: "single", msgtype: "video", video: { url: "https://x/3" } }).files).toEqual([{ url: "https://x/3", type: "video" }]);
  });

  it("drops the bot's leading @mention in a group, and only there", () => {
    expect(withoutMention("@Tomrade hello")).toBe("hello");
    expect(withoutMention("@Tomrade /status")).toBe("/status");
    expect(withoutMention("@Tomrade @Ann /stop")).toBe("/stop");
    expect(withoutMention("@Tomrade @Ann please review")).toBe("@Ann please review");
    expect(withoutMention("please @Tomrade")).toBe("please @Tomrade");
    expect(parseMessage({ ...base, chattype: "single", msgtype: "text", text: { content: "@Ann hi" } }).text).toBe("@Ann hi");
  });

  it("reads what a quote carries", () => {
    expect(quoteText({ msgtype: "text", text: { content: "earlier" } })).toBe("earlier");
    expect(quoteText({ msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "see" } }, { msgtype: "image" }] } })).toBe("see\n[image]");
    expect(quoteText({ msgtype: "file" })).toBe("[file]");
  });
});

describe("files", () => {
  it("decrypts with the message's own key, padded to 32 bytes", () => {
    const key = randomBytes(32);
    const plainBytes = new TextEncoder().encode("a".repeat(40));
    const pad = 32 - (plainBytes.length % 32);
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plainBytes), Buffer.alloc(pad, pad)])), cipher.final()]);
    expect(Buffer.from(decrypt(sealed, key.toString("base64"))).toString()).toBe("a".repeat(40));
    expect(() => decrypt(sealed, randomBytes(32).toString("base64"))).toThrow();
    expect(() => decrypt(sealed, "c2hvcnQ=")).toThrow(/wrong length/);
  });

  it("tells a file's type from its bytes and its name from the download", () => {
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(new TextEncoder().encode("%PDF-1.4"))).toBe("application/pdf");
    expect(sniff(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(fileName(`attachment; filename*=UTF-8''${encodeURIComponent("计划 v2.docx")}`)).toBe("计划 v2.docx");
    expect(fileName('attachment; filename="notes.txt"')).toBe("notes.txt");
    expect(fileName(null)).toBeUndefined();
  });
});
