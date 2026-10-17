import { describe, expect, it } from "vitest";
import { addressOf, fileId, parseFileId, parseMessage, targetOf, titleOf } from "../src/wire.js";

describe("parseMessage", () => {
  it("reads text and the message it quotes", () => {
    expect(parseMessage({ msgtype: "text", text: { content: " hello  \n there", isReplyMsg: true, repliedMsg: { msgId: "m1", msgType: "richText", senderId: "s1", content: { richText: [{ text: "a" }, { text: "b" }] } } } }))
      .toEqual({ text: "hello\n there", files: [], quoted: { messageId: "m1", senderId: "s1", text: "a\nb" } });
  });

  it("takes content given as a JSON string", () => {
    expect(parseMessage({ msgtype: "picture", content: JSON.stringify({ downloadCode: "c1", pictureDownloadCode: "p1" }) })).toEqual({ text: "", files: [{ code: "c1", kind: "image" }] });
  });

  it("reads rich text's lines and pictures, files, videos and voice", () => {
    expect(parseMessage({ msgtype: "richText", content: { richText: [{ text: "one" }, { type: "picture", downloadCode: "c1" }, { text: "two" }] } }))
      .toEqual({ text: "one\ntwo", files: [{ code: "c1", kind: "image" }] });
    expect(parseMessage({ msgtype: "file", content: { downloadCode: "c2", fileName: "a.zip" } }).files).toEqual([{ code: "c2", kind: "file", name: "a.zip" }]);
    expect(parseMessage({ msgtype: "video", content: { downloadCode: "c3", videoType: "mp4" } }).files).toEqual([{ code: "c3", kind: "file", name: "video.mp4" }]);
    expect(parseMessage({ msgtype: "audio", content: { recognition: "你好", downloadCode: "c4" } })).toEqual({ text: "你好", files: [] });
    expect(parseMessage({ msgtype: "unknownMsgType", content: { unknownMsgType: "?" } })).toEqual({ text: "", files: [] });
  });

  it("names a quoted picture or file, and leaves a quoted card out", () => {
    expect(parseMessage({ msgtype: "text", text: { content: "x", isReplyMsg: true, repliedMsg: { msgId: "m1", msgType: "file", content: { fileName: "a.pdf" } } } }).quoted).toEqual({ messageId: "m1", text: "[file: a.pdf]" });
    expect(parseMessage({ msgtype: "text", text: { content: "x", isReplyMsg: true, repliedMsg: { msgId: "m2", msgType: "interactiveCard" } } }).quoted).toEqual({ messageId: "m2", text: "" });
  });
});

describe("addresses", () => {
  it("names a direct chat by its person and a group by its conversation", () => {
    expect(addressOf({ conversationType: "1", conversationId: "cid-dm", senderStaffId: "ann", chatbotCorpId: "ding1" })).toEqual({ tenantId: "ding1", conversationId: "user:ann" });
    expect(addressOf({ conversationType: "2", conversationId: "cidG==", senderStaffId: "ann", senderCorpId: "ding2" })).toEqual({ tenantId: "ding2", conversationId: "cidG==" });
    expect(addressOf({ conversationType: "1", conversationId: "cid-dm", senderId: "$:LWCP_v1:$x" }).conversationId).toBe("user:$:LWCP_v1:$x");
    expect(targetOf({ tenantId: "t", conversationId: "user:ann" })).toEqual({ dm: true, userId: "ann" });
    expect(targetOf({ tenantId: "t", conversationId: "cidG==" })).toEqual({ dm: false, group: "cidG==" });
  });

  it("carries a file's download code in its id", () => {
    expect(parseFileId(fileId({ code: "a|b/c+=", kind: "image" }))).toEqual({ code: "a|b/c+=", kind: "image" });
    expect(parseFileId("nope")).toBeNull();
  });

  it("titles a message by its first plain line", () => {
    expect(titleOf("## **Done** with [it](https://x.y)\nmore")).toBe("Done with it");
    expect(titleOf("")).toBe("Tomrade");
    expect(titleOf("长".repeat(40))).toBe(`${"长".repeat(29)}…`);
  });
});
