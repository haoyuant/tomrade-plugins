import { afterEach, describe, expect, it } from "vitest";
import type { ImAdapter } from "@tomradex/plugin-sdk";
import plugin from "../src/index.js";
import type { ImAdapterSession, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { openDingTalk } from "../src/adapter.js";
import { TEMPLATE } from "../src/card.js";
import { FakeDingTalk, STORAGE } from "../src/fake.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function connect(fake = new FakeDingTalk(), opts: { livenessMs?: number; secret?: string; outbound?: Record<string, Uint8Array>; credentials?: Record<string, string> } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  const warnings: string[] = [];
  const ac = new AbortController();
  const session = await openDingTalk("c1", {
    signal: ac.signal,
    credentials: { clientId: fake.clientId, clientSecret: opts.secret ?? fake.clientSecret, ...opts.credentials },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array()
  }, { net: fake.net(), backoffMs: 5, warn: w => warnings.push(w), ...(opts.livenessMs ? { livenessMs: opts.livenessMs } : {}) });
  const handle = { fake, session, events, states, warnings, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}

const ANN = "user:ann";
const tenant = "dingcorp0001";
let ops = 0;
const delivery = (o: Partial<ImDelivery> & { to: string }): ImDelivery => ({
  operationId: `op${++ops}`, address: { tenantId: tenant, conversationId: o.to }, content: { text: "hello" }, ...o
});
const message = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "message" };

describe("connecting", () => {
  it("registers for robot messages and card callbacks, and opens the socket", async () => {
    const { fake, session, states } = await connect();
    expect(session.identity).toEqual({ id: fake.clientId });
    expect(fake.subscriptions[0]).toEqual([{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }, { type: "CALLBACK", topic: "/v1.0/card/instances/callback" }]);
    expect(fake.sockets).toHaveLength(1);
    expect(states).toEqual(["connected"]);
  });

  it("refuses a wrong secret in DingTalk's words", async () => {
    await expect(connect(new FakeDingTalk(), { secret: "nope" })).rejects.toThrow(/无效的clientId或者clientSecret/);
  });

  it("acknowledges every callback with its messageId, and answers a ping with its own data", async () => {
    const { fake } = await connect();
    const sent = fake.message({ sender: "ann", text: "hi" });
    await until("the acknowledgement", () => fake.answers.has(sent.frameId));
    expect(fake.answers.get(sent.frameId)).toMatchObject({ code: 200, data: { response: null } });
    const ping = fake.ping();
    await until("the pong", () => fake.pongs.length === 1);
    expect(fake.pongs[0]).toMatch(/^opaque-/);
    expect(fake.answers.has(ping)).toBe(false);
  });

  it("brings a new connection up when DingTalk says goodbye, without going offline", async () => {
    const { fake, events, states } = await connect();
    fake.disconnect();
    await until("a second socket", () => fake.sockets.length === 2 && fake.live === fake.sockets[1]);
    expect(fake.sockets[0]!.readyState).toBe(3);
    expect(states).toEqual(["connected"]);
    fake.message({ sender: "ann", text: "after" });
    await until("the message on the new socket", () => events.length === 1);
  });

  it("reconnects with a fresh ticket after a drop", async () => {
    const { fake, events, states } = await connect();
    fake.drop();
    await until("a second socket", () => fake.sockets.length === 2 && fake.live !== null);
    expect(fake.where("POST", /^\/v1\.0\/gateway\/connections\/open$/)).toHaveLength(2);
    expect(states).toEqual(["connected", "connecting", "connected"]);
    fake.message({ sender: "ann", text: "back" });
    await until("the message after the drop", () => events.length === 1);
  });

  it("backs off while registration fails, then connects", async () => {
    const fake = new FakeDingTalk();
    const handle = await connect(fake);
    fake.failNext(c => c.path === "/v1.0/gateway/connections/open", 503, { code: "ServiceUnavailable" }, { times: 2 });
    fake.drop();
    await until("connected again", () => handle.states.at(-1) === "connected" && fake.sockets.length === 2);
    expect(fake.where("POST", /connections\/open$/)).toHaveLength(4);
  });

  it("replaces a socket that has gone quiet", async () => {
    const { fake, states } = await connect(new FakeDingTalk(), { livenessMs: 40 });
    await until("a replacement", () => fake.sockets.length >= 2 && fake.sockets[0]!.readyState === 3, 3000);
    expect(states).toEqual(["connected"]);
  });
});

describe("receiving", () => {
  it("takes a direct message, addressed to the person so a reply reaches them later", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ sender: "ann", text: "hello", nick: "Ann" });
    await until("the message", () => events.length === 1);
    expect(message(events)).toMatchObject({ kind: "message", eventId: sent.msgId, messageId: sent.msgId, text: "hello", activation: "dm",
      actor: { id: "ann", name: "Ann", isBot: false }, address: { tenantId: tenant, conversationId: ANN } });
  });

  it("takes an @ in a group as a mention, and a quote of the robot as a reply with context", async () => {
    const { fake, events } = await connect();
    fake.message({ sender: "ann", text: " help", group: "cidGroup1" });
    fake.message({ sender: "bob", text: "and this?", group: "cidGroup1", mention: false, quote: { msgId: "msgBot", senderId: fake.botUserId, text: "earlier answer" } });
    fake.message({ sender: "bob", text: "chatter", group: "cidGroup1", mention: false });
    await until("all three", () => events.length === 3);
    expect(message(events, 0)).toMatchObject({ activation: "mention", text: "help", address: { conversationId: "cidGroup1" } });
    expect(message(events, 1)).toMatchObject({ activation: "reply", replyTo: "msgBot", context: [{ role: "quoted", messageId: "msgBot", text: "earlier answer", author: { isBot: true } }] });
    expect(message(events, 2).activation).toBe("ambient");
  });

  it("runs a message DingTalk redelivers once", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ sender: "ann", text: "once" });
    await until("the message", () => events.length === 1);
    fake.push("CALLBACK", "/v1.0/im/bot/messages/get", sent.data, sent.frameId);
    fake.push("CALLBACK", "/v1.0/im/bot/messages/get", sent.data);
    await until("the second frame acknowledged", () => fake.answers.size === 2);
    await new Promise(r => setTimeout(r, 30));
    expect(events).toHaveLength(1);
  });

  it("hands over a picture with its real type and size, fetched over https", async () => {
    const fake = new FakeDingTalk();
    fake.files.set("code-pic", { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1, 2]), type: "application/octet-stream" });
    const { session, events } = await connect(fake);
    fake.message({ sender: "ann", type: "picture", content: { downloadCode: "code-pic", pictureDownloadCode: "x" } });
    await until("the picture", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref).toMatchObject({ name: "image-1.png", mimeType: "image/png", size: 13 });
    expect((await session.download!(ref)).byteLength).toBe(13);
    expect(fake.calls.filter(c => c.host === STORAGE).every(c => !c.headers["x-acs-dingtalk-access-token"])).toBe(true);
  });

  it("hands over a file by name, downloading it again when asked", async () => {
    const fake = new FakeDingTalk();
    fake.files.set("code-pdf", { bytes: new Uint8Array(40), type: "application/pdf" });
    const { session, events } = await connect(fake);
    fake.message({ sender: "ann", type: "file", content: { downloadCode: "code-pdf", fileName: "spec.pdf", fileId: "1", spaceId: "2" } });
    await until("the file", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref).toMatchObject({ id: "f|code-pdf", name: "spec.pdf", mimeType: "application/pdf", size: 40 });
    expect((await session.download!(ref)).byteLength).toBe(40);
    expect(fake.where("POST", /messageFiles\/download$/)).toHaveLength(2);
  });

  it("reads rich text and a voice message's transcript", async () => {
    const fake = new FakeDingTalk();
    fake.files.set("code-1", { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]), type: "image/jpeg" });
    const { events } = await connect(fake);
    fake.message({ sender: "ann", type: "richText", content: { richText: [{ text: "see" }, { type: "picture", downloadCode: "code-1" }, { text: "this" }] } });
    fake.message({ sender: "ann", type: "audio", content: { recognition: "钉钉，让进步发生", duration: 4000, downloadCode: "voice" } });
    await until("both", () => events.length === 2);
    expect(message(events, 0)).toMatchObject({ text: "see\nthis", attachments: [{ mimeType: "image/jpeg" }] });
    expect(message(events, 1).text).toBe("钉钉，让进步发生");
  });
});

describe("cards", () => {
  it("posts an AI card with buttons, and passes a press on after acknowledging it at once", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ to: ANN, content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes", style: "primary" }, { label: "No", token: "tk-no" }] } }));
    const card = fake.cards.get(messageId)!;
    expect(card.template).toBe(TEMPLATE);
    expect(card.params).toMatchObject({ flowStatus: "3", staticMsgContent: "Ship it?" });
    expect(fake.buttonsOf(messageId)).toEqual([{ text: "Yes", id: "tk-yes", color: "blue", request: true }, { text: "No", id: "tk-no", color: "blue", request: true }]);
    expect(fake.where("POST", /createAndDeliver$/)[0]!.body).toMatchObject({ callbackType: "STREAM", openSpaceId: "dtv1.card//IM_ROBOT.ann" });
    const press = fake.press({ card: messageId, user: "ann", action: "tk-yes" });
    await until("the answer", () => fake.answers.has(press));
    expect(fake.answers.get(press)!.at - fake.sentAt.get(press)!).toBeLessThan(3000);
    expect(fake.answers.get(press)).toMatchObject({ code: 200, data: { response: {} } });
    await until("the action", () => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "action", token: "tk-yes", actor: { id: "ann" }, address: { tenantId: tenant, conversationId: ANN } });
  });

  it("finds a group card's conversation after a restart", async () => {
    const fake = new FakeDingTalk();
    const first = await connect(fake);
    const { messageId } = await first.session.deliver(delivery({ to: "cidGroup1", content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }] } }));
    first.close();
    const second = await connect(fake);
    fake.press({ card: messageId, user: "bob", action: "tk-yes" });
    await until("the action", () => second.events.length === 1);
    expect(second.events[0]).toMatchObject({ kind: "action", token: "tk-yes", address: { conversationId: "cidGroup1" } });
  });

  it("edits a card in place, closes its buttons, and never posts the same delivery twice", async () => {
    const { fake, session } = await connect();
    const d = delivery({ to: ANN, content: { text: "Pick", actions: [{ label: "A", token: "tk-a" }] } });
    const first = await session.deliver(d);
    expect(await session.deliver(d)).toEqual(first);
    expect(fake.posted(ANN)).toHaveLength(1);
    await session.deliver({ ...d, operationId: "edit", replaceMessageId: first.messageId, content: { text: "Question handled" } });
    expect(fake.textOf(fake.posted(ANN)[0]!)).toBe("Question handled");
    expect(fake.buttonsOf(first.messageId)).toEqual([]);
  });

  it("writes a card whose first post's answer was lost instead of posting another", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.path.endsWith("createAndDeliver"), 502, { code: "BadGateway" });
    const d = delivery({ to: ANN, content: { text: "once" } });
    await expect(session.deliver(d)).rejects.toMatchObject({ disposition: "retryable" });
    // DingTalk made the card all the same.
    const id = (fake.where("POST", /createAndDeliver$/)[0]!.body as { outTrackId: string }).outTrackId;
    fake.cards.set(id, { id, template: TEMPLATE, params: {}, streamed: "", finalized: false });
    expect(await session.deliver(d)).toEqual({ messageId: id });
    expect(fake.cards.get(id)!.params.staticMsgContent).toBe("once");
  });

  it("@s the person who asked in a group, once per message", async () => {
    const { fake, session } = await connect();
    const asked = fake.message({ sender: "bob", text: "help", group: "cidGroup1", nick: "Bob" });
    await until("the message", () => fake.answers.has(asked.frameId));
    await new Promise(r => setTimeout(r, 20));
    const d = (text: string) => delivery({ to: "cidGroup1", replyTo: asked.msgId, content: { text } });
    await session.deliver(d("first"));
    await session.deliver(d("second"));
    expect(fake.posted("cidGroup1").map(p => p.card?.atUserIds)).toEqual([{ bob: "Bob" }, undefined]);
    expect(fake.where("POST", /createAndDeliver$/)[0]!.body).toMatchObject({ openSpaceId: "dtv1.card//IM_GROUP.cidGroup1", imGroupOpenDeliverModel: { robotCode: fake.clientId } });
  });

  it("renders sections and links, web links as links and app links as text", async () => {
    const { fake, session } = await connect();
    const { messageId } = await session.deliver(delivery({ to: ANN, content: { text: "Created", elements: [
      { type: "section", title: "TOM-1 Fix it", fields: [{ label: "Status", value: "Todo" }] },
      { type: "links", links: [{ label: "PR #3", url: "https://github.com/x/y/pull/3" }, { label: "Open in Tomrade", url: "tomrade://item/p/TOM-1" }] }
    ] } }));
    expect(fake.cards.get(messageId)!.params.staticMsgContent).toBe("Created\n\n**TOM-1 Fix it**<br>**Status**: Todo\n\n[PR #3](https://github.com/x/y/pull/3)<br>Open in Tomrade: tomrade://item/p/TOM-1");
  });
});

describe("streaming", () => {
  const stream = (session: ImAdapterSession) => session.stream!;

  it("streams into an AI card and settles it with its buttons", async () => {
    const { fake, session } = await connect();
    const d = delivery({ to: ANN, content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    expect(fake.cards.get(messageId)!.params).toMatchObject({ flowStatus: "2", msgContent: "Hel" });
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo\nworld" });
    expect(fake.cards.get(messageId)!.streamed).toBe("Hello<br>world");
    expect(fake.where("PUT", /card\/streaming$/)[0]!.body).toMatchObject({ key: "msgContent", isFull: true, isFinalize: false });
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there", actions: [{ label: "More", token: "tk" }] } });
    expect(fake.cards.get(messageId)).toMatchObject({ finalized: true, params: { flowStatus: "3", msgContent: "Hello there" } });
    expect(fake.buttonsOf(messageId)).toEqual([{ text: "More", id: "tk", color: "blue", request: true }]);
    expect(fake.posted(ANN)).toHaveLength(1);
  });
});

describe("without cards", () => {
  const noCards = async () => {
    const fake = new FakeDingTalk();
    fake.noCards = true;
    return connect(fake);
  };

  it("replies with Markdown through the session webhook, buttons as /answer lines, and says why once", async () => {
    const { fake, session, events, warnings } = await noCards();
    fake.message({ sender: "ann", text: "hi" });
    await until("the message", () => events.length === 1);
    await session.deliver(delivery({ to: ANN, content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }] } }));
    await session.deliver(delivery({ to: ANN, content: { text: "again" } }));
    expect(fake.posted(ANN).map(p => [p.via, p.text])).toEqual([["webhook", "Ship it?\n\nYes：/answer tk-yes"], ["webhook", "again"]]);
    expect(fake.where("POST", /createAndDeliver$/)).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Card\.Instance\.Write/);
  });

  it("@s the asker through a group's session webhook", async () => {
    const { fake, session, events } = await noCards();
    const asked = fake.message({ sender: "bob", text: "help", group: "cidGroup1" });
    await until("the message", () => events.length === 1);
    await session.deliver(delivery({ to: "cidGroup1", replyTo: asked.msgId, content: { text: "on it" } }));
    expect(fake.posted("cidGroup1")[0]).toMatchObject({ via: "webhook", text: "on it\n\n@bob", at: ["bob"] });
  });

  it("reaches a direct chat through the robot's API once the session webhook has lapsed", async () => {
    const { fake, session, events } = await noCards();
    fake.message({ sender: "ann", text: "hi", webhookTtlMs: 30_000 });
    await until("the message", () => events.length === 1);
    await session.deliver(delivery({ to: ANN, content: { text: "late" } }));
    expect(fake.posted(ANN)[0]).toMatchObject({ via: "api", kind: "sampleMarkdown", text: "late", param: { title: "late" } });
    expect(fake.where("POST", /oToMessages\/batchSend$/)[0]!.body).toMatchObject({ robotCode: fake.clientId, userIds: ["ann"] });
  });

  it("falls back to the group API when DingTalk no longer takes the session webhook", async () => {
    const { fake, session, events } = await noCards();
    fake.message({ sender: "bob", text: "help", group: "cidGroup1" });
    await until("the message", () => events.length === 1);
    fake.expireWebhooks();
    await session.deliver(delivery({ to: "cidGroup1", content: { text: "still here" } }));
    await session.deliver(delivery({ to: "cidGroup1", content: { text: "and again" } }));
    expect(fake.posted("cidGroup1").map(p => [p.via, p.text])).toEqual([["api", "still here"], ["api", "and again"]]);
    expect(fake.where("POST", /groupMessages\/send$/)[0]!.body).toMatchObject({ openConversationId: "cidGroup1", msgKey: "sampleMarkdown" });
    // A webhook DingTalk refused is not tried again.
    expect(fake.calls.filter(c => c.path === "/robot/sendBySession")).toHaveLength(1);
  });

  it("reaches a direct chat after a restart, with no webhook known", async () => {
    const { fake, session } = await noCards();
    await session.deliver(delivery({ to: ANN, content: { text: "proactive" } }));
    expect(fake.posted(ANN)[0]).toMatchObject({ via: "api", text: "proactive" });
  });

  it("posts a streamed reply once it settles", async () => {
    const { fake, session } = await noCards();
    const d = delivery({ to: ANN, content: { text: "Hel" } });
    const { messageId } = await session.stream!.start(d);
    await session.stream!.append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.posted(ANN)).toHaveLength(0);
    const settled = await session.stream!.stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.posted(ANN).map(p => p.text)).toEqual(["Hello"]);
    expect(settled.messageId).toMatch(/^m/);
  });
});

describe("files", () => {
  it("uploads images and documents, then sends them through the robot's API", async () => {
    const { fake, session } = await connect(new FakeDingTalk(), { outbound: { f1: new Uint8Array(10), f2: new Uint8Array(20) } });
    await session.deliver(delivery({ to: "cidGroup1", content: { text: "files", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 10 }, { id: "f2", name: "spec.pdf", mimeType: "application/pdf", size: 20 }] } }));
    expect(fake.uploads.map(u => [u.type, u.name, u.size])).toEqual([["image", "a.png", 10], ["file", "spec.pdf", 20]]);
    expect(fake.posted("cidGroup1").map(p => p.kind)).toEqual(["card", "sampleImageMsg", "sampleFile"]);
    expect(fake.posted("cidGroup1")[1]!.param).toEqual({ photoURL: fake.uploads[0]!.mediaId });
    expect(fake.posted("cidGroup1")[2]!.param).toEqual({ mediaId: fake.uploads[1]!.mediaId, fileName: "spec.pdf", fileType: "pdf" });
  });

  it("sends a file alone to a direct chat", async () => {
    const { fake, session } = await connect(new FakeDingTalk(), { outbound: { f1: new Uint8Array(5) } });
    const { messageId } = await session.deliver(delivery({ to: ANN, content: { text: "", files: [{ id: "f1", name: "notes.zip", mimeType: "application/zip", size: 5 }] } }));
    expect(messageId).toMatch(/^m/);
    expect(fake.posted(ANN).map(p => p.kind)).toEqual(["sampleFile"]);
  });

  it("does not resend the card when only a file failed", async () => {
    const { fake, session } = await connect(new FakeDingTalk(), { outbound: { f1: new Uint8Array(5) } });
    fake.failNext(c => c.path === "/media/upload", 503, { errcode: -1, errmsg: "busy" });
    const d = delivery({ to: ANN, content: { text: "with file", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 5 }] } });
    await expect(session.deliver(d)).rejects.toMatchObject({ disposition: "retryable" });
    await session.deliver(d);
    expect(fake.posted(ANN).map(p => p.kind)).toEqual(["card", "sampleImageMsg"]);
  });
});

describe("reactions", () => {
  it("puts DingTalk's thinking emotion on a message and takes it away when the turn ends", async () => {
    const { fake, session, events } = await connect();
    const sent = fake.message({ sender: "ann", text: "go" });
    await until("the message", () => events.length === 1);
    const address = { tenantId: tenant, conversationId: ANN };
    await session.react!({ address, messageId: sent.msgId, reaction: "received" });
    await session.react!({ address, messageId: sent.msgId, reaction: "received" });
    expect(fake.emotions).toEqual([{ msgId: sent.msgId, conversation: "cid-dm-ann", text: "🤔思考中", recalled: false }]);
    await session.react!({ address, messageId: sent.msgId, reaction: "done" });
    expect(fake.emotions[0]!.recalled).toBe(true);
  });

  it("takes the emotion away even when a quick turn ends before it was put on", async () => {
    const { fake, session, events } = await connect();
    const sent = fake.message({ sender: "ann", text: "quick" });
    await until("the message", () => events.length === 1);
    const address = { tenantId: tenant, conversationId: ANN };
    await Promise.all([session.react!({ address, messageId: sent.msgId, reaction: "received" }), session.react!({ address, messageId: sent.msgId, reaction: "done" })]);
    expect(fake.emotions).toEqual([{ msgId: sent.msgId, conversation: "cid-dm-ann", text: "🤔思考中", recalled: true }]);
  });
});

describe("limits", () => {
  it("waits out a card rate limit for as long as DingTalk's gate", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.path.endsWith("createAndDeliver"), 403, { code: "Forbidden.AccessDenied.QpsLimitForAppkeyAndApi", message: "QPS" });
    await expect(session.deliver(delivery({ to: ANN }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 2000 });
  });

  it("waits a minute when the robot sends too fast, or as long as DingTalk says", async () => {
    const fake = new FakeDingTalk();
    fake.noCards = true;
    const { session } = await connect(fake);
    fake.failNext(c => c.path.endsWith("oToMessages/batchSend"), 400, { code: "send.too.fast", message: "发送消息频率过快" });
    await expect(session.deliver(delivery({ to: ANN }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 60_000 });
    fake.failNext(c => c.path.endsWith("oToMessages/batchSend"), 429, { code: "system.busy" }, { headers: { "retry-after": "3" } });
    await expect(session.deliver(delivery({ to: ANN }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 3000 });
  });

  it("takes a robot message lost in flight as uncertain, never resending it blind", async () => {
    const fake = new FakeDingTalk();
    fake.noCards = true;
    const { session } = await connect(fake);
    fake.failNext(c => c.path.endsWith("oToMessages/batchSend"), 500, { code: "system.error" });
    await expect(session.deliver(delivery({ to: ANN }))).rejects.toMatchObject({ disposition: "uncertain" });
  });

  it("renews a token DingTalk stopped taking", async () => {
    const { fake, session } = await connect();
    fake.expireTokens();
    await session.deliver(delivery({ to: ANN }));
    expect(fake.where("POST", /oauth2\/accessToken$/)).toHaveLength(2);
  });

  it("uses the robot code and card template it is given", async () => {
    const fake = new FakeDingTalk();
    const { session } = await connect(fake, { credentials: { cardTemplateId: "mine.schema" } });
    const { messageId } = await session.deliver(delivery({ to: "cidGroup1" }));
    expect(fake.cards.get(messageId)!.template).toBe("mine.schema");
    expect(fake.where("POST", /createAndDeliver$/)[0]!.body).toMatchObject({ imGroupOpenDeliverModel: { robotCode: fake.clientId } });
  });
});

describe("using it in a group", () => {
  it("shows its own steps for a group in IM settings, in English and Chinese", async () => {
    const adapters: ImAdapter[] = [];
    await plugin.apply({ im: { register: async (a: ImAdapter) => { adapters.push(a); return () => {}; } } } as never, undefined as never);
    expect(adapters.length).toBeGreaterThan(0);
    for (const a of adapters) {
      const steps = a.setup!.groupSteps! as { en: string; zh: string }[];
      expect(steps).toHaveLength(3);
      expect(steps.every(s => s.en && s.zh)).toBe(true);
    }
  });
});
