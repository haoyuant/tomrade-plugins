import { afterEach, describe, expect, it } from "vitest";
import type { ImAdapterSession, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { openWecom, type WecomOptions } from "../src/adapter.js";
import { THINKING } from "../src/card.js";
import { FakeWecom } from "../src/fake.js";
import type { Net } from "../src/gateway.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function connect(fake = new FakeWecom(), opts: WecomOptions & { secret?: string; server?: string; outbound?: Record<string, Uint8Array> } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  const ac = new AbortController();
  const { secret, server, outbound, ...rest } = opts;
  const session = await openWecom("c1", {
    signal: ac.signal,
    credentials: { botId: fake.botId, secret: secret ?? fake.secret, ...(server ? { server } : {}) },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => outbound?.[id] ?? new Uint8Array()
  }, { net: fake.net(), backoffMs: 5, refreshMs: 5, graceMs: 20, ...rest });
  const handle = { fake, session, events, states, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

let ops = 0;
const BOT = new FakeWecom().botId;
const delivery = (conv: string, o: Partial<ImDelivery> = {}): ImDelivery => ({ operationId: `op${++ops}`, address: { tenantId: BOT, conversationId: conv }, content: { text: "hello" }, ...o });
const message = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "message" };
const stream = (session: ImAdapterSession) => session.stream!;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("connecting", () => {
  it("subscribes with the Bot ID and Secret and pings on its interval", async () => {
    const { fake, session } = await connect(new FakeWecom(), { pingMs: 20 });
    expect(session.identity).toEqual({ id: fake.botId });
    expect(fake.live?.subscribed).toBe(true);
    await until("a second ping", () => fake.pings >= 2);
    expect(fake.sockets).toHaveLength(1);
  });

  it("refuses a wrong secret in WeCom's words", async () => {
    await expect(connect(new FakeWecom(), { secret: "nope" })).rejects.toThrow(/853000: invalid bot_id or secret/);
  });

  it("takes a private deployment's address, and only a WebSocket one", async () => {
    const { fake } = await connect(new FakeWecom(), { server: "wss://aibot.example.internal" });
    expect(fake.sockets[0]!.url).toBe("wss://aibot.example.internal");
    await expect(connect(new FakeWecom(), { server: "https://aibot.example.internal" })).rejects.toThrow(/wss:\/\//);
  });

  it("reconnects after a drop and subscribes again", async () => {
    const { fake, events, states } = await connect();
    expect(fake.sockets[0]!.url).toBe("wss://openws.work.weixin.qq.com");
    fake.drop();
    await until("a second subscription", () => fake.sockets.length === 2 && !!fake.live);
    expect(states).toEqual(["connected", "connecting", "connected"]);
    fake.message({ from: "ann", text: "back" });
    await until("the message after the drop", () => events.length === 1);
  });

  it("backs off longer after each failed attempt", async () => {
    const fake = new FakeWecom();
    const base = fake.net();
    const tries: number[] = [];
    const Flaky = function (url: string) {
      tries.push(Date.now());
      if (tries.length < 4) throw new Error("refused");
      return new base.WebSocket(url);
    } as unknown as typeof WebSocket;
    const flaky: Net = { fetch: base.fetch, WebSocket: Flaky };
    await connect(fake, { net: flaky, backoffMs: 50 });
    expect(tries).toHaveLength(4);
    const gaps = tries.slice(1).map((t, i) => t - tries[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(45);
    expect(gaps[2]!).toBeGreaterThan(gaps[0]!);
  });

  it("drops a connection whose pings go unanswered", async () => {
    const fake = new FakeWecom();
    fake.silent = true;
    await connect(fake, { pingMs: 10, livenessMs: 30 });
    await until("a reconnect", () => fake.sockets.length >= 2, 3000);
  });

  it("stops when another connection takes the bot over", async () => {
    const { fake, states } = await connect();
    fake.kick();
    await until("the error", () => states.includes("error"));
    await pause(50);
    expect(fake.sockets).toHaveLength(1);
  });
});

describe("receiving", () => {
  it("takes a direct message", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    expect(message(events)).toEqual({ kind: "message", eventId: sent.msgid, messageId: sent.msgid, text: "hello", activation: "dm",
      actor: { id: "ann", isBot: false }, address: { tenantId: fake.botId, conversationId: "ann" } });
  });

  it("takes a group @mention without the mention, and a command after other mentions", async () => {
    const { fake, events } = await connect();
    fake.message({ from: "ann", chat: "wrkG1", text: "help me" });
    fake.message({ from: "ann", chat: "wrkG1", body: { text: { content: "@Tomrade @Bob /status" } } });
    await until("both", () => events.length === 2);
    expect(message(events, 0)).toMatchObject({ text: "help me", activation: "mention", actor: { id: "ann" }, address: { conversationId: "wrkG1" } });
    expect(message(events, 1).text).toBe("/status");
  });

  it("keeps a quote as context, and knows a quote of its own reply", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "plan it" });
    await until("the message", () => events.length === 1);
    const { messageId } = await session.deliver(delivery("ann", { content: { text: "**Plan**: ship on Friday" } }));
    fake.message({ from: "ann", text: "why Friday?", quote: { msgtype: "text", text: { content: "Plan: ship on Friday" } } });
    fake.message({ from: "ann", text: "and this?", quote: { msgtype: "text", text: { content: "someone else's words" } } });
    await until("both quotes", () => events.length === 3);
    expect(message(events, 1)).toMatchObject({ replyTo: messageId, context: [{ role: "quoted", messageId, author: { id: fake.botId, isBot: true }, text: "Plan: ship on Friday" }] });
    expect(message(events, 2).replyTo).toBeUndefined();
    expect(message(events, 2).context).toEqual([{ role: "quoted", messageId: expect.stringMatching(/^quote:/), author: { id: "unknown", isBot: false }, text: "someone else's words" }]);
  });

  it("keeps a redelivered message once and replies on its newest req_id", async () => {
    const { fake, session, events } = await connect();
    const sent = fake.message({ from: "ann", chat: "wrkG1", text: "once" });
    await until("the message", () => events.length === 1);
    const again = fake.callback(sent.body, false);
    await pause(30);
    expect(events).toHaveLength(1);
    await session.deliver(delivery("wrkG1", { replyTo: sent.msgid }));
    expect(fake.frames.at(-1)).toMatchObject({ cmd: "aibot_respond_msg", reqId: again });
  });

  it("decrypts an image a direct message carries", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", type: "image", body: { image: fake.file(PNG) } });
    await until("the image", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref).toMatchObject({ name: "image-1.png", mimeType: "image/png", size: PNG.length });
    expect([...await session.download!(ref)]).toEqual([...PNG]);
  });

  it("names a file by its download, and reads a group's mixed message", async () => {
    const { fake, events } = await connect();
    const pdf = new TextEncoder().encode("%PDF-1.7 a small document");
    fake.message({ from: "ann", type: "file", body: { file: fake.file(pdf, "规格 spec.pdf") } });
    fake.message({ from: "ann", chat: "wrkG1", type: "mixed", body: { mixed: { msg_item: [{ msgtype: "text", text: { content: "@Tomrade look at this" } }, { msgtype: "image", image: fake.file(PNG) }] } } });
    await until("both", () => events.length === 2);
    expect(message(events, 0).attachments).toEqual([{ id: expect.any(String), name: "规格 spec.pdf", mimeType: "application/pdf", size: pdf.length }]);
    expect(message(events, 1)).toMatchObject({ text: "look at this", attachments: [{ mimeType: "image/png" }] });
  });

  it("reports a file past the limit at its size, without reading it", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", type: "file", body: { file: fake.file(new Uint8Array(21 * 1024 * 1024), "big.bin") } });
    await until("the file", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref.size).toBeGreaterThan(20 * 1024 * 1024);
    await expect(session.download!(ref)).rejects.toThrow(/too large/);
  });
});

describe("replying", () => {
  it("pushes into a direct chat, and in a group replies on the asking message's callback", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "hi" });
    const asked = fake.message({ from: "bob", chat: "wrkG1", text: "status?" });
    await until("both", () => events.length === 2);
    await session.deliver(delivery("ann"));
    expect(fake.frames.at(-1)).toMatchObject({ cmd: "aibot_send_msg", body: { chatid: "ann", chat_type: 1, msgtype: "markdown", markdown: { content: "hello" } } });
    await session.deliver(delivery("wrkG1", { replyTo: asked.msgid }));
    expect(fake.frames.at(-1)).toMatchObject({ cmd: "aibot_respond_msg", reqId: asked.reqId, body: { msgtype: "markdown" } });
    expect(fake.chat("wrkG1").at(-1)!.replyTo).toBe(asked.msgid);
  });

  it("pushes once WeCom no longer takes replies on the callback", async () => {
    const { fake, session, events } = await connect();
    const asked = fake.message({ from: "bob", chat: "wrkG1", text: "status?" });
    await until("the message", () => events.length === 1);
    fake.replyMs = -1;
    await session.deliver(delivery("wrkG1", { replyTo: asked.msgid }));
    await session.deliver(delivery("wrkG1", { replyTo: asked.msgid }));
    expect(fake.frames.map(f => f.cmd)).toEqual(["aibot_send_msg", "aibot_send_msg"]);
    expect(fake.frames[0]!.body).toMatchObject({ chatid: "wrkG1", chat_type: 2 });
  });

  it("pushes when the callback's 24 hours are over", async () => {
    let t = Date.now();
    const { fake, session, events } = await connect(new FakeWecom(), { now: () => t });
    const asked = fake.message({ from: "bob", chat: "wrkG1", text: "status?" });
    await until("the message", () => events.length === 1);
    t += 24 * 3_600_000;
    await session.deliver(delivery("wrkG1", { replyTo: asked.msgid }));
    expect(fake.frames.map(f => f.cmd)).toEqual(["aibot_send_msg"]);
  });

  it("never posts the same message twice", async () => {
    const { fake, session } = await connect();
    const d = delivery("ann", { content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }] } });
    const first = await session.deliver(d);
    expect(await session.deliver(d)).toEqual(first);
    expect(fake.chat("ann")).toHaveLength(1);
    expect(fake.chat("ann")[0]).toMatchObject({ kind: "template_card", card: { card_type: "button_interaction", main_title: { title: "Ship it?" }, task_id: first.messageId } });
  });

  it("sends a ticket's sections and links as Markdown, then its buttons", async () => {
    const { fake, session } = await connect();
    await session.deliver(delivery("ann", { content: { text: "TOM-1 is ready for your review", actions: [{ label: "Accept", token: "tk-a" }, { label: "Request changes", token: "tk-c" }],
      elements: [{ type: "section", title: "TOM-1 Ship", fields: [{ label: "Status", value: "Verifying" }] }, { type: "links", links: [{ label: "PR #7", url: "https://github.com/o/r/pull/7" }, { label: "Open in Tomrade", url: "tomrade://item/p/TOM-1" }] }] } }));
    expect(fake.chat("ann").map(s => s.kind)).toEqual(["markdown", "template_card"]);
    expect(fake.chat("ann")[0]!.text).toBe("TOM-1 is ready for your review\n\n**TOM-1 Ship**\n**Status**: Verifying\n\n[PR #7](https://github.com/o/r/pull/7)\nOpen in Tomrade: tomrade://item/p/TOM-1");
  });
});

describe("streaming", () => {
  it("opens a thinking placeholder for a waiting message, and the reply takes it over", async () => {
    const { fake, session, events } = await connect();
    const asked = fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    const address = { tenantId: fake.botId, conversationId: "ann" };
    await session.indicate!({ address, state: "typing" });
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", text: THINKING, finished: false, replyTo: asked.msgid }]);
    const d = delivery("ann", { content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    expect(messageId).toBe(fake.chat("ann")[0]!.id);
    await stream(session).append({ operationId: "a1", address, messageId, delta: "lo" });
    await until("the refresh", () => fake.chat("ann")[0]!.text === "Hello");
    expect(await stream(session).stop({ operationId: "s1", address, messageId, content: { text: "Hello there" } })).toEqual({ messageId });
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", first: THINKING, text: "Hello there", finished: true }]);
    await session.indicate!({ address, state: "typing" });
    expect(fake.chat("ann")).toHaveLength(1);
  });

  it("ends a placeholder no reply took, once the turn is over", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    const address = { tenantId: fake.botId, conversationId: "ann" };
    await session.indicate!({ address, state: "typing" });
    await session.indicate!({ address, state: "idle" });
    await until("the placeholder ends", () => fake.chat("ann")[0]!.finished);
    expect(fake.chat("ann")[0]!.text).toBe("✓");
  });

  it("puts a question's text into the placeholder and its buttons on a card", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "pick" });
    await until("the message", () => events.length === 1);
    await session.indicate!({ address: { tenantId: fake.botId, conversationId: "ann" }, state: "typing" });
    await session.deliver(delivery("ann", { content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }] } }));
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", text: "Ship it?", finished: true }, { kind: "template_card", card: { main_title: { title: "Ship it?" } } }]);
  });

  it("folds appends into a refresh at most every refreshMs", async () => {
    const { fake, session, events } = await connect(new FakeWecom(), { refreshMs: 60 });
    fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    const d = delivery("ann", { content: { text: "a" } });
    const { messageId } = await stream(session).start(d);
    for (let i = 0; i < 20; i++) await stream(session).append({ operationId: `a${i}`, address: d.address, messageId, delta: "a" });
    await until("the refresh", () => fake.chat("ann")[0]!.text === "a".repeat(21), 1000);
    expect(fake.chat("ann")[0]!.frames).toBeLessThanOrEqual(3);
  });

  it("leaves the placeholder to its own message when a newer one gets a receipt", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "first" });
    await until("the message", () => events.length === 1);
    await session.indicate!({ address: { tenantId: fake.botId, conversationId: "ann" }, state: "typing" });
    fake.message({ from: "ann", text: "second" });
    await until("the second", () => events.length === 2);
    await session.deliver(delivery("ann", { content: { text: "Queued (1 in line)" } }));
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", text: THINKING, finished: false }, { kind: "markdown", text: "Queued (1 in line)" }]);
    const { messageId } = await stream(session).start(delivery("ann", { content: { text: "answer" } }));
    expect(messageId).toBe(fake.chat("ann")[0]!.id);
  });

  it("keeps a long answer within 30 messages a minute and still delivers it whole", async () => {
    const t = Date.now();
    const { fake, session, events } = await connect(new FakeWecom(), { now: () => t, refreshMs: 0 });
    fake.message({ from: "ann", text: "write a lot" });
    await until("the message", () => events.length === 1);
    const d = delivery("ann", { content: { text: "word " } });
    const { messageId } = await stream(session).start(d);
    let all = "word ";
    for (let i = 0; i < 300; i++) {
      all += `word${i} `;
      await stream(session).append({ operationId: `a${i}`, address: d.address, messageId, delta: `word${i} ` });
      if (i % 5 === 0) await pause(2);
    }
    await pause(50);
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: all.trim() } });
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", text: all.trim(), finished: true }]);
    // The refreshes left room: a card still fits after the answer.
    await session.deliver(delivery("ann", { content: { text: "More?", actions: [{ label: "Yes", token: "tk" }] } }));
    let refused: unknown;
    for (let i = 0; i < 10 && !refused; i++) await session.deliver(delivery("ann")).catch(e => { refused = e; });
    expect(refused).toMatchObject({ disposition: "retryable", retryAfterMs: 60_000 });
    expect(fake.busiest("ann")).toBe(30);
  });

  it("delivers the final text as a new message once a stream's ten minutes are up", async () => {
    let t = Date.now();
    const { fake, session, events } = await connect(new FakeWecom(), { now: () => t });
    fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    const d = delivery("ann", { content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    t += 10 * 60_000;
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    const settled = await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(settled.messageId).not.toBe(messageId);
    expect(fake.chat("ann")).toMatchObject([{ kind: "stream", text: "Hel", finished: false }, { kind: "markdown", text: "Hello" }]);
  });

  it("delivers the final text as a new message when WeCom says the stream is over", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    const d = delivery("ann", { content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    fake.failNext((cmd, body) => cmd === "aibot_respond_msg" && (body.stream as { finish?: boolean } | undefined)?.finish === true, 846608);
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.chat("ann").at(-1)).toMatchObject({ kind: "markdown", text: "Hello" });
  });

  it("pushes the whole answer at the end where there is no callback to stream on", async () => {
    const { fake, session } = await connect();
    const d = delivery("bob", { content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    await pause(20);
    expect(fake.frames).toHaveLength(0);
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.frames).toMatchObject([{ cmd: "aibot_send_msg", body: { chatid: "bob", markdown: { content: "Hello" } } }]);
  });

  it("refreshes the same stream when a failed start is retried", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: "ann", text: "hello" });
    await until("the message", () => events.length === 1);
    fake.failNext(cmd => cmd === "aibot_respond_msg", -1);
    await expect(stream(session).start(delivery("ann", { operationId: "stream:b:r:0:v1:p0", content: { text: "He" } }))).rejects.toMatchObject({ disposition: "retryable" });
    const { messageId } = await stream(session).start(delivery("ann", { operationId: "stream:b:r:0:v2:p0", content: { text: "Hel" } }));
    expect(fake.chat("ann")).toMatchObject([{ id: messageId, text: "Hel" }]);
  });
});

describe("cards", () => {
  it("answers a button press within five seconds and passes its token on", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery("ann", { content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes" }, { label: "No", token: "tk-no" }] } }));
    const press = fake.press({ from: "ann", taskId: messageId, key: "b.tk-yes" });
    await until("the update", () => fake.updates.length === 1);
    expect(fake.updates[0]!.at - fake.sentAt.get(press)!).toBeLessThan(5000);
    expect(fake.updates[0]!.body).toMatchObject({ response_type: "update_template_card", template_card: { task_id: messageId, button_list: [{ text: "✓ Yes" }] } });
    expect(fake.updates[0]!.body).not.toHaveProperty("userids");
    await until("the action", () => events.length === 1);
    expect(events[0]).toEqual({ kind: "action", eventId: press, token: "tk-yes", actor: { id: "ann", isBot: false }, address: { tenantId: fake.botId, conversationId: "ann" } });
  });

  it("passes a select's choice and a multi-select's choices", async () => {
    const { fake, session, events } = await connect();
    const single = await session.deliver(delivery("ann", { content: { text: "Model", elements: [{ type: "select", token: "tk-model", options: [{ label: "Opus", value: "claude-opus" }, { label: "Sonnet", value: "sonnet 4" }] }] } }));
    const multi = await session.deliver(delivery("ann", { content: { text: "Which?", elements: [{ type: "select", token: "tk-pick", multiple: true, options: [{ label: "A", value: "a" }, { label: "B b", value: "b b" }] }] } }));
    expect(fake.cards("ann")[0]).toMatchObject({ card_type: "vote_interaction", checkbox: { question_key: "s.tk-model", mode: 0, option_list: [{ id: "v.claude-opus", text: "Opus" }, { id: "o1", text: "Sonnet" }] } });
    fake.press({ from: "ann", taskId: single.messageId, key: "submit", selected: [{ question_key: "s.tk-model", ids: ["o1"] }] });
    fake.press({ from: "ann", taskId: multi.messageId, key: "submit", selected: [{ question_key: "m.tk-pick", ids: ["v.a", "o1"] }] });
    await until("both", () => events.length === 2);
    expect(events[0]).toMatchObject({ kind: "action", token: "tk-model", value: "sonnet 4" });
    expect(events[1]).toMatchObject({ kind: "action", token: "tk-pick", value: ["a", "b b"] });
    expect(fake.cards("ann")[1]).toMatchObject({ checkbox: { disable: true, option_list: [{ id: "v.a", is_checked: true }, { id: "o1", is_checked: true }] }, submit_button: { text: "✓" } });
  });

  it("in a group shows the answer only to whoever pressed", async () => {
    const { fake, session, events } = await connect();
    const asked = fake.message({ from: "ann", chat: "wrkG1", text: "go?" });
    await until("the message", () => events.length === 1);
    const { messageId } = await session.deliver(delivery("wrkG1", { replyTo: asked.msgid, content: { text: "Go?", actions: [{ label: "Go", token: "tk-go" }] } }));
    fake.press({ from: "bob", chat: "wrkG1", taskId: messageId, key: "b.tk-go" });
    await until("the update", () => fake.updates.length === 1);
    expect(fake.updates[0]!.body).toMatchObject({ userids: ["bob"] });
    await until("the action", () => events.length === 2);
    expect(events[1]).toMatchObject({ kind: "action", actor: { id: "bob" }, address: { conversationId: "wrkG1" } });
  });

  it("still passes on a button of a card from before a restart, once", async () => {
    const { fake, events } = await connect();
    fake.press({ from: "ann", taskId: "t-old", key: "b.tk-old" });
    fake.press({ from: "ann", taskId: "t-old", key: "b.tk-old" });
    await until("the action", () => events.length === 1);
    await pause(20);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "action", token: "tk-old" });
    expect(fake.updates).toHaveLength(0);
  });
});

describe("files", () => {
  it("uploads an image and a document in chunks and sends them on the chat's callback", async () => {
    const doc = new Uint8Array(1_200_000).map((_, i) => i % 251);
    const { fake, session, events } = await connect(new FakeWecom(), { outbound: { f1: PNG, f2: doc } });
    const asked = fake.message({ from: "ann", text: "files please" });
    await until("the message", () => events.length === 1);
    await session.deliver(delivery("ann", { content: { text: "files", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: PNG.length }, { id: "f2", name: "spec.pdf", mimeType: "application/pdf", size: doc.length }] } }));
    expect(fake.chat("ann").map(s => s.kind)).toEqual(["markdown", "image", "file"]);
    const [image, file] = fake.chat("ann").slice(1).map(s => fake.media.get(s.mediaId!)!);
    expect(image).toMatchObject({ type: "image", filename: "a.png" });
    expect([...image!.bytes]).toEqual([...PNG]);
    expect(file).toMatchObject({ type: "file", filename: "spec.pdf" });
    expect(Buffer.from(file!.bytes).equals(Buffer.from(doc))).toBe(true);
    expect(fake.frames.slice(1).every(f => f.cmd === "aibot_respond_msg" && f.reqId === asked.reqId)).toBe(true);
  });

  it("leaves out a file too small for WeCom", async () => {
    const { fake, session } = await connect(new FakeWecom(), { outbound: { f1: new Uint8Array(3) } });
    await session.deliver(delivery("ann", { content: { text: "tiny", files: [{ id: "f1", name: "t.txt", mimeType: "text/plain", size: 3 }] } }));
    expect(fake.chat("ann").map(s => s.kind)).toEqual(["markdown"]);
  });
});

describe("limits", () => {
  it("takes WeCom's message limit as retryable", async () => {
    const { fake, session } = await connect();
    fake.failNext(cmd => cmd === "aibot_send_msg", 846607);
    await expect(session.deliver(delivery("ann"))).rejects.toMatchObject({ disposition: "retryable", code: 846607 });
  });

  it("waits for room under 30 messages a minute", async () => {
    const t = Date.now();
    const { fake, session } = await connect(new FakeWecom(), { now: () => t });
    for (let i = 0; i < 30; i++) await session.deliver(delivery("ann"));
    await expect(session.deliver(delivery("ann"))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 60_000 });
    await session.deliver(delivery("bob"));
    expect(fake.busiest("ann")).toBe(30);
  });

  it("takes a refusal as permanent and a lost answer as uncertain", async () => {
    const { fake, session } = await connect(new FakeWecom(), { ackMs: 30 });
    fake.failNext(cmd => cmd === "aibot_send_msg", 42033);
    await expect(session.deliver(delivery("ann"))).rejects.toMatchObject({ disposition: "permanent", code: 42033 });
    fake.failNext(cmd => cmd === "aibot_send_msg", "silent");
    await expect(session.deliver(delivery("ann"))).rejects.toMatchObject({ disposition: "uncertain" });
  });
});
