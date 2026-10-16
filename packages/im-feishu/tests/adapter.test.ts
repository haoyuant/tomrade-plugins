import { afterEach, describe, expect, it } from "vitest";
import type { ImAdapterSession, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { openFeishu } from "../src/adapter.js";
import { FakeFeishu } from "../src/fake.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function connect(fake = new FakeFeishu(), opts: { livenessMs?: number; secret?: string; outbound?: Record<string, Uint8Array> } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  const ac = new AbortController();
  const session = await openFeishu("c1", {
    signal: ac.signal,
    credentials: { appId: fake.appId, appSecret: opts.secret ?? fake.appSecret },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array()
  }, { domain: "feishu", net: fake.net(), backoffMs: 5, ...(opts.livenessMs ? { livenessMs: opts.livenessMs } : {}) });
  const handle = { fake, session, events, states, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}

let ops = 0;
const delivery = (o: Partial<ImDelivery> & { chat: string }): ImDelivery => ({
  operationId: `op${++ops}`, address: { tenantId: "tenant-1", conversationId: o.chat, ...(o.address?.topicId ? { topicId: o.address.topicId } : {}) },
  content: { text: "hello" }, ...o
});
const message = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "message" };

describe("connecting", () => {
  it("signs in as the bot and pings on Feishu's interval", async () => {
    const fake = new FakeFeishu();
    fake.pingInterval = 0.02;
    const { session } = await connect(fake);
    expect(session.identity).toEqual({ id: "ou_bot", name: "Tomrade Bot" });
    await until("a second ping", () => fake.pings >= 2);
    expect(fake.sockets).toHaveLength(1);
  });

  it("refuses a wrong secret in Feishu's words", async () => {
    await expect(connect(new FakeFeishu(), { secret: "nope" })).rejects.toThrow(/app secret invalid/);
  });

  it("reconnects through a fresh address after a drop", async () => {
    const { fake, events, states } = await connect();
    fake.drop();
    await until("a second socket", () => fake.sockets.length === 2 && fake.live !== null);
    expect(fake.where("POST", /^\/callback\/ws\/endpoint$/)).toHaveLength(2);
    expect(states).toEqual(["connected", "connecting", "connected"]);
    fake.message({ chat: "oc_dm", sender: "ou_ann", text: "back" });
    await until("the message after the drop", () => events.length === 1);
  });

  it("drops a connection whose pings go unanswered", async () => {
    const fake = new FakeFeishu();
    fake.silent = true;
    await connect(fake, { livenessMs: 30 });
    await until("a reconnect", () => fake.sockets.length >= 2, 3000);
  });
});

describe("receiving", () => {
  it("takes a direct message with its sender's name", async () => {
    const fake = new FakeFeishu();
    fake.users.set("ou_ann", "Ann");
    const { events } = await connect(fake);
    const sent = fake.message({ chat: "oc_dm", sender: "ou_ann", text: "hello" });
    await until("the message", () => events.length === 1);
    expect(message(events)).toMatchObject({ kind: "message", eventId: sent.eventId, messageId: sent.id, text: "hello", activation: "dm",
      actor: { id: "ou_ann", name: "Ann", isBot: false }, address: { tenantId: "tenant-1", conversationId: "oc_dm" } });
  });

  it("answers in groups only when @'d or replied to, and keeps a topic's messages together", async () => {
    const { fake, session, events } = await connect();
    fake.message({ chat: "oc_g", chatType: "group", sender: "ou_ann", text: "chatter" });
    const asked = fake.message({ chat: "oc_g", chatType: "group", sender: "ou_ann", text: "help", mention: true });
    await until("both", () => events.length === 2);
    expect(message(events, 0).activation).toBe("ambient");
    expect(message(events, 1)).toMatchObject({ activation: "mention", text: "help", address: { conversationId: "oc_g" } });
    expect(message(events, 1).address.topicId).toBeUndefined();

    const { messageId } = await session.deliver(delivery({ chat: "oc_g", replyTo: asked.id }));
    expect(fake.where("POST", /\/reply$/).at(-1)!.body).not.toHaveProperty("reply_in_thread");
    fake.message({ chat: "oc_g", chatType: "group", sender: "ou_bob", text: "and this?", parent: messageId, root: asked.id });
    await until("the reply", () => events.length === 3);
    expect(message(events)).toMatchObject({ activation: "reply", replyTo: messageId, context: [{ role: "quoted", text: "hello", author: { isBot: true } }] });

    fake.message({ chat: "oc_g", chatType: "group", sender: "ou_ann", text: "in a topic", mention: true, thread: "omt_x", root: "om_root" });
    await until("the topic message", () => events.length === 4);
    expect(message(events).address).toEqual({ tenantId: "tenant-1", conversationId: "oc_g", topicId: "om_root" });
  });

  it("answers in the topic, and follows it there without an @", async () => {
    const { fake, session, events } = await connect();
    const root = fake.message({ chat: "oc_g", chatType: "group", sender: "ou_ann", text: "topic start", mention: true });
    await until("the start", () => events.length === 1);
    await session.deliver(delivery({ chat: "oc_g", threadId: root.id, address: { tenantId: "tenant-1", conversationId: "oc_g", topicId: root.id } }));
    expect(fake.where("POST", new RegExp(`/messages/${root.id}/reply$`)).at(-1)!.body).toMatchObject({ reply_in_thread: true });
    fake.message({ chat: "oc_g", chatType: "group", sender: "ou_bob", text: "more", thread: "omt_1", root: root.id });
    await until("the follow-up", () => events.length === 2);
    expect(message(events)).toMatchObject({ activation: "reply", address: { topicId: root.id }, context: [{ role: "root", text: "topic start", author: { id: "ou_ann" } }] });
  });

  it("joins an event sent in parts", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ chat: "oc_dm", sender: "ou_ann", text: "长".repeat(500), parts: 3 });
    await until("the message", () => events.length === 1);
    expect(message(events).text).toBe("长".repeat(500));
    await until("the acknowledgement", () => fake.answers.has(sent.eventId));
    expect(fake.answers.get(sent.eventId)!.code).toBe(200);
  });

  it("hands over a message's image with its real size", async () => {
    const fake = new FakeFeishu();
    fake.files.set("img_1", { bytes: new Uint8Array([1, 2, 3, 4]), type: "image/png" });
    const { session, events } = await connect(fake);
    fake.message({ chat: "oc_dm", sender: "ou_ann", type: "image", content: { image_key: "img_1" } });
    await until("the image", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref).toMatchObject({ name: "image-1.png", mimeType: "image/png", size: 4 });
    expect([...await session.download!(ref)]).toEqual([1, 2, 3, 4]);
  });

  it("tells the IM layer a withdrawn message was the sender's", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ chat: "oc_dm", sender: "ou_ann", text: "oops" });
    await until("the message", () => events.length === 1);
    fake.event("im.message.recalled_v1", { message_id: sent.id, chat_id: "oc_dm", recall_type: "message_owner" });
    await until("the withdrawal", () => events.length === 2);
    expect(events[1]).toMatchObject({ kind: "retract", messageId: sent.id, actor: { id: "ou_ann" } });
  });

  it("runs a bot-menu entry as a command in the person's direct chat", async () => {
    const { fake, events } = await connect();
    fake.message({ chat: "oc_dm", sender: "ou_ann", text: "hi" });
    await until("the message", () => events.length === 1);
    fake.event("application.bot.menu_v6", { operator: { operator_id: { open_id: "ou_ann" } }, event_key: "new" });
    await until("the command", () => events.length === 2);
    expect(message(events)).toMatchObject({ text: "/new", activation: "dm", address: { conversationId: "oc_dm" } });
  });
});

describe("cards", () => {
  it("acknowledges a button at once and passes its token on", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ chat: "oc_g", content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }] }, address: { tenantId: "tenant-1", conversationId: "oc_g", topicId: "om_root" } }));
    const card = fake.posted("oc_g")[0]!.card as { body: { elements: { tag: string; columns?: { elements: { behaviors: { value: unknown }[] }[] }[] }[] } };
    const value = card.body.elements.find(e => e.tag === "column_set")!.columns![0]!.elements[0]!.behaviors[0]!.value;
    const press = fake.press({ messageId, operator: "ou_ann", value });
    await until("the answer", () => fake.answers.has(press));
    expect(fake.answers.get(press)!.at - fake.sentAt.get(press)!).toBeLessThan(3000);
    expect(fake.answers.get(press)).toMatchObject({ code: 200, data: {} });
    await until("the action", () => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "action", token: "tk-yes", actor: { id: "ou_ann" }, address: { conversationId: "oc_g", topicId: "om_root" } });
  });

  it("passes a form's choices on", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ chat: "oc_dm", content: { text: "Pick", elements: [{ type: "select", token: "tk-pick", multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] } }));
    fake.press({ messageId, operator: "ou_ann", value: { k: "f", t: "tk-pick" }, form: { v: ["a", "b"] } });
    await until("the action", () => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "action", token: "tk-pick", value: ["a", "b"] });
  });

  it("edits a card in place and never posts the same message twice", async () => {
    const { fake, session } = await connect();
    const d = delivery({ chat: "oc_dm" });
    const first = await session.deliver(d);
    expect(await session.deliver(d)).toEqual(first);
    expect(fake.posted("oc_dm")).toHaveLength(1);
    await session.deliver({ ...d, operationId: "edit", replaceMessageId: first.messageId, content: { text: "edited" } });
    expect(fake.textOf(fake.posted("oc_dm")[0]!.card)).toBe("edited");
  });

  it("sends images and documents after the card", async () => {
    const { fake, session } = await connect(new FakeFeishu(), { outbound: { f1: new Uint8Array(10), f2: new Uint8Array(20) } });
    await session.deliver(delivery({ chat: "oc_dm", content: { text: "files", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 10 }, { id: "f2", name: "spec.pdf", mimeType: "application/pdf", size: 20 }] } }));
    expect(fake.posted("oc_dm").map(m => m.msgType)).toEqual(["interactive", "image", "file"]);
    expect(fake.where("POST", /\/im\/v1\/files$/)[0]!.body).toMatchObject({ file_type: "pdf", file_name: "spec.pdf" });
  });
});

describe("streaming", () => {
  const stream = (session: ImAdapterSession) => session.stream!;

  it("streams into a card entity and settles it", async () => {
    const { fake, session } = await connect();
    const d = delivery({ chat: "oc_dm", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    const post = fake.messages.get(messageId)!;
    expect(fake.cards.get(post.cardId!)!.streaming).toBe(true);
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.cards.get(post.cardId!)!.text).toBe("Hello");
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there", actions: [{ label: "More", token: "tk" }] } });
    expect(fake.cards.get(post.cardId!)).toMatchObject({ streaming: false, text: "Hello there" });
    await session.deliver({ ...d, operationId: "later", replaceMessageId: messageId, content: { text: "Superseded" } });
    expect(fake.cards.get(post.cardId!)!.text).toBe("Superseded");
    expect(fake.where("PATCH", /^\/open-apis\/im\/v1\/messages\//)).toHaveLength(0);
  });

  it("edits a plain card when CardKit is not granted", async () => {
    const fake = new FakeFeishu();
    fake.noCardkit = true;
    const { session } = await connect(fake);
    const d = delivery({ chat: "oc_dm", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.textOf(fake.posted("oc_dm")[0]!.card)).toBe("Hello");
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there" } });
    expect(fake.textOf(fake.posted("oc_dm")[0]!.card)).toBe("Hello there");
    await stream(session).start(delivery({ chat: "oc_dm" }));
    expect(fake.where("POST", /^\/open-apis\/cardkit\/v1\/cards$/)).toHaveLength(1);
  });

  it("finds a streamed card's entity after a restart", async () => {
    const fake = new FakeFeishu();
    const first = await connect(fake);
    const d = delivery({ chat: "oc_dm", content: { text: "Hel" } });
    const { messageId } = await stream(first.session).start(d);
    first.close();
    const second = await connect(fake);
    await stream(second.session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.cards.get(fake.messages.get(messageId)!.cardId!)).toMatchObject({ streaming: false, text: "Hello" });
  });
});

describe("limits", () => {
  it("waits out a rate limit as long as Feishu says", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "POST" && c.path === "/open-apis/im/v1/messages", 429, 99991400, { retryAfter: 2 });
    await expect(session.deliver(delivery({ chat: "oc_dm" }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 2000 });
  });

  it("takes a chat's message limit as retryable", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "POST" && c.path === "/open-apis/im/v1/messages", 400, 230020);
    await expect(session.deliver(delivery({ chat: "oc_dm" }))).rejects.toMatchObject({ disposition: "retryable" });
  });

  it("renews a token Feishu stopped taking", async () => {
    const { fake, session } = await connect();
    fake.expireTokens();
    await session.deliver(delivery({ chat: "oc_dm" }));
    expect(fake.where("POST", /tenant_access_token/)).toHaveLength(2);
  });

  it("reacts and swaps the reaction for the outcome", async () => {
    const { fake, session } = await connect();
    const address = { tenantId: "tenant-1", conversationId: "oc_dm" };
    await session.react!({ address, messageId: "om_9", reaction: "received" });
    await session.react!({ address, messageId: "om_9", reaction: "done" });
    expect(fake.reactions.map(r => [r.emoji, r.removed])).toEqual([["OnIt", true], ["DONE", false]]);
  });
});
