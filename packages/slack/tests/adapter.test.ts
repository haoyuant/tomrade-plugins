import { afterEach, describe, expect, it } from "vitest";
import type { ImAdapter, ImAdapterSession, ImDelivery, ImInbound, ImNotice } from "@tomradex/plugin-sdk";
import { openSlack } from "../src/adapter.js";
import { FakeSlack } from "../src/fake.js";
import plugin from "../src/index.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

async function connect(fake = new FakeSlack(), opts: { appToken?: string; botToken?: string; idleMs?: number; outbound?: Record<string, Uint8Array> } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  /** What the adapter told the host: notices, and `clear:<key>` once their cause went. */
  const notices: (ImNotice | string)[] = [];
  const ac = new AbortController();
  const session = await openSlack("c1", {
    signal: ac.signal,
    credentials: { appToken: opts.appToken ?? fake.appToken, botToken: opts.botToken ?? fake.botToken },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array(),
    notice: n => { notices.push(n); },
    clearNotice: key => { notices.push(`clear:${key}`); }
  }, { net: fake.net(), backoffMs: 5, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}) });
  const handle = { fake, session, events, states, notices, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}

let ops = 0;
const delivery = (o: Partial<ImDelivery> & { channel: string; topic?: string }): ImDelivery => ({
  operationId: `op${++ops}`, address: { tenantId: "T0FAKE", conversationId: o.channel, ...(o.topic ? { topicId: o.topic } : {}) },
  content: { text: "hello" }, ...o
});
const message = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "message" };
const action = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "action" };
type Element = { type: string; action_id?: string; value?: string; url?: string; options?: { value: string }[] };
const elements = (blocks: Record<string, unknown>[] | undefined) => (blocks ?? []).flatMap(b => [...((b.elements ?? []) as Element[]), ...(b.element ? [b.element as Element] : [])]);

describe("connecting", () => {
  it("signs in with both tokens and says who the bot is", async () => {
    const fake = new FakeSlack();
    const { session, states } = await connect(fake);
    expect(session.identity).toEqual({ id: "U0BOT", name: "Tomrade" });
    expect(fake.where("apps.connections.open")[0]!.token).toBe(fake.appToken);
    expect(fake.where("auth.test")[0]!.token).toBe(fake.botToken);
    expect(states).toEqual(["connected"]);
  });

  it("refuses a wrong bot token or app token in Slack's words", async () => {
    await expect(connect(new FakeSlack(), { botToken: "xoxb-wrong" })).rejects.toThrow(/Bot Token \(invalid_auth\)/);
    await expect(connect(new FakeSlack(), { appToken: "xapp-wrong" })).rejects.toThrow(/App-Level Token \(invalid_auth\)/);
    const fake = new FakeSlack();
    await expect(connect(fake, { appToken: fake.botToken, botToken: fake.appToken })).rejects.toThrow(/starts with xapp-/);
  });

  it("acknowledges every envelope at once", async () => {
    const { fake } = await connect();
    const sent = [fake.message({ channel: "D0ANN", user: "U0ANN", text: "hi" }).envelopeId, fake.command({ channel: "D0ANN", user: "U0ANN", text: "status" }),
      fake.event({ type: "app_home_opened", user: "U0ANN", tab: "messages" }).envelopeId];
    for (const id of sent) expect(fake.acks.get(id)!.at - fake.sentAt.get(id)!).toBeLessThan(50);
  });

  it("moves to a fresh connection when Slack asks, and lets the old one go after hello", async () => {
    const { fake, events, states } = await connect();
    const first = fake.live!;
    fake.disconnect("refresh_requested");
    await until("a second socket", () => fake.sockets.length === 2 && first.readyState === 3);
    expect(fake.live).toBe(fake.sockets[1]);
    expect(states).toEqual(["connected", "connected"]);
    fake.message({ channel: "D0ANN", user: "U0ANN", text: "still here" });
    await until("the message on the new socket", () => events.length === 1);
  });

  it("reconnects through a fresh address after a drop", async () => {
    const { fake, events, states } = await connect();
    fake.drop();
    await until("a second socket", () => fake.sockets.length === 2 && fake.live !== null && states.at(-1) === "connected");
    expect(fake.where("apps.connections.open")).toHaveLength(2);
    expect(states).toEqual(["connected", "connecting", "connected"]);
    fake.message({ channel: "D0ANN", user: "U0ANN", text: "back" });
    await until("the message after the drop", () => events.length === 1);
  });

  it("replaces a socket that has been quiet too long", async () => {
    const { fake } = await connect(new FakeSlack(), { idleMs: 30 });
    await until("a fresh socket", () => fake.sockets.length >= 2 && fake.sockets[0]!.readyState === 3, 3000);
  });

  it("stops for good when Socket Mode is switched off", async () => {
    const { fake, states } = await connect();
    fake.live!.push({ type: "disconnect", reason: "link_disabled" });
    await until("the error", () => states.at(-1) === "error");
    await new Promise(r => setTimeout(r, 50));
    expect(fake.where("apps.connections.open")).toHaveLength(1);
  });
});

describe("receiving", () => {
  it("takes a direct message as its own thread, with the sender's name", async () => {
    const fake = new FakeSlack();
    fake.users.set("U0ANN", "Ann");
    const { events } = await connect(fake);
    const sent = fake.message({ channel: "D0ANN", user: "U0ANN", text: "hello &amp; <https://x.test|this>" });
    await until("the message", () => events.length === 1);
    expect(message(events)).toMatchObject({ kind: "message", eventId: sent.eventId, messageId: sent.ts, text: "hello & [this](https://x.test)", activation: "dm",
      actor: { id: "U0ANN", name: "Ann", isBot: false }, address: { tenantId: "T0FAKE", conversationId: "D0ANN", topicId: sent.ts } });
    const reply = fake.message({ channel: "D0ANN", user: "U0ANN", text: "more", thread: sent.ts });
    await until("the reply", () => events.length === 2);
    expect(message(events)).toMatchObject({ messageId: `${reply.ts}@${sent.ts}`, address: { topicId: sent.ts } });
  });

  it("answers in channels when @'d, then follows the thread it answered in", async () => {
    const { fake, session, events } = await connect();
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "chatter" });
    const asked = fake.message({ channel: "C0DEV", user: "U0ANN", text: "help me", mention: true });
    await until("both", () => events.length === 2);
    expect(message(events, 0).activation).toBe("ambient");
    expect(message(events, 1)).toMatchObject({ activation: "mention", text: "help me", messageId: asked.ts, address: { tenantId: "T0FAKE", conversationId: "C0DEV" } });
    expect(message(events, 1).address.topicId).toBeUndefined();

    await session.deliver(delivery({ channel: "C0DEV", threadId: asked.ts }));
    expect(fake.posted("C0DEV")[0]!.thread).toBe(asked.ts);
    const followUp = fake.message({ channel: "C0DEV", user: "U0BOB", text: "and this?", thread: asked.ts });
    await until("the follow-up", () => events.length === 3);
    expect(message(events)).toMatchObject({ activation: "reply", messageId: `${followUp.ts}@${asked.ts}` });
    // A reply to the follow-up stays in the same thread.
    await session.deliver(delivery({ channel: "C0DEV", threadId: message(events).messageId }));
    expect(fake.posted("C0DEV")[1]!.thread).toBe(asked.ts);

    fake.message({ channel: "C0DEV", user: "U0BOB", text: "elsewhere", thread: "1600000000.000001" });
    await until("a thread it is not in", () => events.length === 4);
    expect(message(events).activation).toBe("ambient");
  });

  it("knows a thread it answered in before a restart, and hands over its first message", async () => {
    const fake = new FakeSlack();
    const first = await connect(fake);
    const root = fake.message({ channel: "C0DEV", user: "U0ANN", text: "the plan for Q3" });
    fake.message({ channel: "C0DEV", user: "U0BOB", text: "what do you think?", thread: root.ts, mention: true });
    await until("the mention", () => first.events.length === 2);
    expect(message(first.events)).toMatchObject({ activation: "mention", context: [{ role: "root", messageId: root.ts, text: "the plan for Q3", author: { id: "U0ANN", isBot: false } }] });
    await first.session.deliver(delivery({ channel: "C0DEV", threadId: message(first.events).messageId }));
    first.close();
    const second = await connect(fake);
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "go on", thread: root.ts });
    await until("the follow-up", () => second.events.length === 1);
    expect(message(second.events)).toMatchObject({ activation: "reply" });
  });

  it("takes a channel mention once, though Slack sends it twice", async () => {
    const { fake, events } = await connect();
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "once", mention: true });
    await new Promise(r => setTimeout(r, 50));
    expect(events).toHaveLength(1);
  });

  it("keeps a redelivered event's id, and passes it on once", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ channel: "D0ANN", user: "U0ANN", text: "once" });
    fake.event(sent.event, { eventId: sent.eventId, retry: 1 });
    await new Promise(r => setTimeout(r, 50));
    expect(events.map(e => e.eventId)).toEqual([sent.eventId]);
  });

  it("hands over a message's files with their size, and downloads them with the bot token", async () => {
    const { fake, session, events } = await connect();
    fake.message({ channel: "D0ANN", user: "U0ANN", text: "see", files: [{ id: "F1", name: "shot.png", mimetype: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) }] });
    await until("the message", () => events.length === 1);
    const ref = message(events).attachments![0]!;
    expect(ref).toEqual({ id: "F1", name: "shot.png", mimeType: "image/png", size: 4 });
    expect([...await session.download!(ref)]).toEqual([1, 2, 3, 4]);
  });

  it("tells the IM layer a deleted or edited message was the sender's", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ channel: "D0ANN", user: "U0ANN", text: "oops" });
    await until("the message", () => events.length === 1);
    fake.event({ type: "message", subtype: "message_changed", channel: "D0ANN", channel_type: "im", ts: fake.ts(),
      message: { type: "message", user: "U0ANN", text: "oops!", ts: sent.ts, edited: { user: "U0ANN", ts: fake.ts() } } });
    fake.event({ type: "message", subtype: "message_changed", channel: "D0ANN", channel_type: "im", ts: fake.ts(),
      message: { type: "message", user: "U0ANN", text: "oops!", ts: sent.ts, reply_count: 1 } });
    fake.event({ type: "message", subtype: "message_deleted", channel: "D0ANN", channel_type: "im", ts: fake.ts(), deleted_ts: sent.ts,
      previous_message: { type: "message", user: "U0ANN", text: "oops!", ts: sent.ts } });
    await until("both", () => events.length === 3);
    expect(events.slice(1)).toMatchObject([
      { kind: "edit", messageId: sent.ts, actor: { id: "U0ANN" }, address: { topicId: sent.ts } },
      { kind: "retract", messageId: sent.ts, actor: { id: "U0ANN" }, address: { topicId: sent.ts } }
    ]);
  });

  it("ignores its own messages and other bots'", async () => {
    const { fake, events } = await connect();
    fake.event({ type: "message", channel: "D0ANN", channel_type: "im", user: "U0BOT", bot_id: "B0BOT", text: "mine", ts: fake.ts() });
    fake.event({ type: "message", subtype: "bot_message", channel: "C0DEV", channel_type: "channel", bot_id: "B0OTHER", text: "theirs", ts: fake.ts() });
    await new Promise(r => setTimeout(r, 50));
    expect(events).toEqual([]);
  });
});

describe("commands", () => {
  it("runs /tomrade <command> as that command, in the thread last written in", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ channel: "D0ANN", user: "U0ANN", text: "hi" });
    await until("the message", () => events.length === 1);
    const id = fake.command({ channel: "D0ANN", user: "U0ANN", text: "status" });
    await until("the command", () => events.length === 2);
    expect(message(events)).toMatchObject({ text: "/status", activation: "dm", address: { conversationId: "D0ANN", topicId: sent.ts } });
    expect(fake.acks.get(id)!.payload).toEqual({ text: "› /tomrade status" });
    fake.command({ channel: "C0DEV", user: "U0ANN", text: "" });
    fake.command({ channel: "D0ANN", user: "U0ANN", text: "pair 123456" });
    fake.command({ channel: "C0DEV", user: "U0ANN", text: "summarize the backlog" });
    await until("the rest", () => events.length === 5);
    expect(events.slice(2).map(e => [(e as { text: string }).text, (e as { activation: string }).activation])).toEqual([["/help", "mention"], ["/pair 123456", "dm"], ["summarize the backlog", "mention"]]);
  });

  it("stops the thread's turn from Slack's stop button", async () => {
    const { fake, events } = await connect();
    fake.event({ type: "agent_session_stopped", user: "U0ANN", channel: "D0ANN", thread_ts: "1600000000.000001", event_ts: "1600000001.000001", streaming_message_ts: [] });
    await until("the stop", () => events.length === 1);
    expect(message(events)).toMatchObject({ text: "/stop", activation: "dm", actor: { id: "U0ANN" }, address: { conversationId: "D0ANN", topicId: "1600000000.000001" } });
  });
});

describe("messages and controls", () => {
  it("posts into the thread, and never twice for one operation", async () => {
    const { fake, session } = await connect();
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001" });
    const first = await session.deliver(d);
    expect(await session.deliver(d)).toEqual(first);
    expect(fake.posted("D0ANN")).toMatchObject([{ thread: "1600000000.000001", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }] }]);
  });

  it("acknowledges a button at once and passes its token on", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk-yes", style: "primary" }] } }));
    const button = elements(fake.find("D0ANN", messageId)!.blocks).find(e => e.type === "button")!;
    expect(button).toMatchObject({ value: "tk-yes", style: "primary" });
    const press = fake.press({ channel: "D0ANN", ts: messageId, user: "U0ANN", action: { type: "button", block_id: "x", action_id: button.action_id, value: button.value } });
    expect(fake.acks.get(press)!.at - fake.sentAt.get(press)!).toBeLessThan(50);
    await until("the action", () => events.length === 1);
    expect(action(events)).toMatchObject({ kind: "action", token: "tk-yes", actor: { id: "U0ANN" }, address: { conversationId: "D0ANN", topicId: "1600000000.000001" } });
  });

  it("answers a select as soon as it is chosen, and a multi-select or text entry on submit", async () => {
    const { fake, session, events } = await connect();
    const long = "x".repeat(200);
    const { messageId } = await session.deliver(delivery({ channel: "C0DEV", content: { text: "Pick", elements: [
      { type: "select", token: "tk-one", options: [{ label: "A", value: "a" }, { label: "Long", value: long }] },
      { type: "select", token: "tk-many", multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] },
      { type: "input", token: "tk-text", label: "Other", placeholder: "Say more" }] } }));
    const blocks = fake.find("C0DEV", messageId)!.blocks!;
    expect(blocks.map(b => b.type)).toEqual(["section", "actions", "input", "actions", "input", "actions"]);
    const select = elements(blocks).find(e => e.type === "static_select")!;
    expect(select.options!.map(o => o.value)).toEqual(["a", "#1"]);
    fake.press({ channel: "C0DEV", ts: messageId, user: "U0ANN", action: { type: "static_select", block_id: blocks[1]!.block_id, action_id: select.action_id, selected_option: { value: "#1" } } });
    const submit = elements(blocks).filter(e => e.type === "button");
    fake.press({ channel: "C0DEV", ts: messageId, user: "U0ANN", action: { type: "button", block_id: "s", action_id: submit[0]!.action_id, value: submit[0]!.value },
      state: { "tomrade:f:tk-many": { v: { type: "multi_static_select", selected_options: [{ value: "a" }, { value: "b" }] } }, "tomrade:f:tk-text": { v: { type: "plain_text_input", value: null } } } });
    fake.press({ channel: "C0DEV", ts: messageId, user: "U0ANN", action: { type: "button", block_id: "s", action_id: submit[1]!.action_id, value: submit[1]!.value },
      state: { "tomrade:f:tk-text": { v: { type: "plain_text_input", value: "ship friday" } } } });
    await until("three answers", () => events.length === 3);
    expect(events.map(e => [(e as { token: string }).token, (e as { value?: unknown }).value])).toEqual([["tk-one", long], ["tk-many", ["a", "b"]], ["tk-text", "ship friday"]]);
    expect(action(events).address).toEqual({ tenantId: "T0FAKE", conversationId: "C0DEV" });
  });

  it("removes the controls when a question is settled", async () => {
    const { fake, session } = await connect();
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk" }] } });
    const { messageId } = await session.deliver(d);
    await session.deliver({ ...d, operationId: "settle", replaceMessageId: messageId, content: { text: "Ship it?\nYes" } });
    expect(fake.where("chat.update")).toHaveLength(1);
    expect(fake.find("D0ANN", messageId)!.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "Ship it?\nYes" } }]);
  });

  it("shows tickets as sections with fields, web links as buttons and app links as text", async () => {
    const { fake, session } = await connect();
    const { messageId } = await session.deliver(delivery({ channel: "C0DEV", content: { text: "", elements: [
      { type: "section", title: "TOM-1 Fix <login>", fields: [{ label: "Status", value: "Doing" }] },
      { type: "links", links: [{ label: "Pull request #3", url: "https://github.com/x/y/pull/3" }, { label: "Open in Tomrade", url: "tomrade://item/p/TOM-1" }] }] } }));
    const m = fake.find("C0DEV", messageId)!;
    expect(m.text).toBe("TOM-1 Fix <login>");
    expect(m.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*TOM-1 Fix &lt;login&gt;*" }, fields: [{ type: "mrkdwn", text: "*Status*\nDoing" }] },
      { type: "context", elements: [{ type: "mrkdwn", text: "Open in Tomrade: tomrade://item/p/TOM-1" }] },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Pull request #3", emoji: true }, url: "https://github.com/x/y/pull/3", action_id: "tomrade:l:0" }] }
    ]);
  });

  it("uploads files into the thread, with the text as their comment", async () => {
    const { fake, session } = await connect(new FakeSlack(), { outbound: { f1: new Uint8Array(10), f2: new Uint8Array(20) } });
    await session.deliver(delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Saved *spec.pdf*", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 10 }, { id: "f2", name: "spec.pdf", mimeType: "application/pdf", size: 20 }] } }));
    expect(fake.where("files.getUploadURLExternal").map(c => c.args)).toEqual([{ filename: "a.png", length: "10" }, { filename: "spec.pdf", length: "20" }]);
    expect(fake.posted("D0ANN")).toMatchObject([{ thread: "1600000000.000001", text: "Saved *spec.pdf*", files: [expect.any(String), expect.any(String)] }]);
    expect([...fake.files.values()].filter(f => f.shared).map(f => f.bytes.byteLength)).toEqual([10, 20]);
  });

  it("posts a message with controls before its files", async () => {
    const { fake, session } = await connect(new FakeSlack(), { outbound: { f1: new Uint8Array(3) } });
    await session.deliver(delivery({ channel: "D0ANN", content: { text: "Take it?", actions: [{ label: "Yes", token: "tk" }], files: [{ id: "f1", name: "a.txt", mimeType: "text/plain", size: 3 }] } }));
    expect(fake.posted("D0ANN").map(m => [!!m.blocks, !!m.files])).toEqual([[true, false], [false, true]]);
    expect(fake.posted("D0ANN")[1]!.text).toBe("");
  });
});

describe("ticket threads", () => {
  const TITLE = "TOM-42 · Doing · Fix <login> & more";
  const room = { tenantId: "T0FAKE", conversationId: "C0DEV" };

  it("posts a parent message naming the ticket, whose thread is its topic, and leaves the channel's other threads alone", async () => {
    const { fake, session, events } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: room, title: TITLE });
    const parent = fake.find("C0DEV", topicId)!;
    expect(parent).toMatchObject({ text: "TOM-42 · Doing · Fix &lt;login&gt; &amp; more", metadata: { event_type: "tomrade_topic" } });
    expect(parent.thread).toBeUndefined();

    const reply = fake.message({ channel: "C0DEV", user: "U0ANN", text: "what is left?", thread: topicId });
    await until("the reply", () => events.length === 1);
    expect(message(events)).toMatchObject({ activation: "reply", messageId: `${reply.ts}@${topicId}`, address: { ...room, topicId } });

    const asked = fake.message({ channel: "C0DEV", user: "U0ANN", text: "help", mention: true });
    await until("the mention", () => events.length === 2);
    await session.deliver(delivery({ channel: "C0DEV", threadId: asked.ts }));
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "and?", thread: asked.ts });
    await until("the follow-up", () => events.length === 3);
    expect(message(events)).toMatchObject({ activation: "reply", address: room });
    expect(message(events).address.topicId).toBeUndefined();
  });

  it("posts, streams and shows its status into the ticket's thread, and its buttons answer from there", async () => {
    const { fake, session, events } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: room, title: TITLE });
    const { messageId } = await session.deliver(delivery({ channel: "C0DEV", topic: topicId, threadId: topicId, content: { text: "Ship it?", actions: [{ label: "Yes", token: "tk" }] } }));
    expect(fake.find("C0DEV", messageId)!.thread).toBe(topicId);
    const button = elements(fake.find("C0DEV", messageId)!.blocks).find(e => e.type === "button")!;
    fake.press({ channel: "C0DEV", ts: messageId, user: "U0ANN", action: { type: "button", block_id: "x", action_id: button.action_id, value: button.value } });
    await until("the press", () => events.length === 1);
    expect(action(events).address).toEqual({ ...room, topicId });

    fake.message({ channel: "C0DEV", user: "U0ANN", text: "go", thread: topicId });
    await until("the message", () => events.length === 2);
    const streamed = await session.stream!.start(delivery({ channel: "C0DEV", topic: topicId, content: { text: "On it" } }));
    expect(fake.find("C0DEV", streamed.messageId)).toMatchObject({ thread: topicId, streaming: true });
    await session.indicate!({ address: { ...room, topicId }, state: "typing" });
    expect(fake.statuses.at(-1)).toMatchObject({ channel: "C0DEV", thread: topicId });
  });

  it("knows a ticket's thread after a restart, by its parent's metadata", async () => {
    const fake = new FakeSlack();
    const first = await connect(fake);
    const { topicId } = await first.session.topics!.open({ operationId: "topic:1", address: room, title: TITLE });
    const { topicId: other } = await first.session.topics!.open({ operationId: "topic:2", address: room, title: "TOM-43 · Doing · Else" });
    const asked = fake.message({ channel: "C0DEV", user: "U0ANN", text: "help", mention: true });
    await until("the mention", () => first.events.length === 1);
    await first.session.deliver(delivery({ channel: "C0DEV", threadId: asked.ts }));
    first.close();

    const second = await connect(fake);
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "still on it?", thread: topicId });
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "and this?", thread: asked.ts });
    await until("both", () => second.events.length === 2);
    expect(message(second.events, 0)).toMatchObject({ activation: "reply", address: { ...room, topicId } });
    expect(message(second.events, 1)).toMatchObject({ activation: "reply", address: room });
    expect(message(second.events, 1).address.topicId).toBeUndefined();
    expect(fake.where("conversations.replies")[0]!.args.include_all_metadata).toBe("true");

    // A delivery into a ticket thread the restarted adapter has not read yet marks it as the ticket's.
    await second.session.deliver(delivery({ channel: "C0DEV", topic: other, threadId: other }));
    fake.message({ channel: "C0DEV", user: "U0ANN", text: "next?", thread: other });
    await until("the third", () => second.events.length === 3);
    expect(message(second.events)).toMatchObject({ address: { ...room, topicId: other } });
  });

  it("posts the parent once for one operation", async () => {
    const { fake, session } = await connect();
    const first = await session.topics!.open({ operationId: "topic:1", address: room, title: TITLE });
    expect(await session.topics!.open({ operationId: "topic:1", address: room, title: TITLE })).toEqual(first);
    expect(fake.posted("C0DEV")).toHaveLength(1);
  });

  it("rewrites the parent as the ticket moves, marks it closed once done, and skips what changes nothing", async () => {
    const { fake, session } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: room, title: "TOM-42 · Doing · Fix" });
    const address = { ...room, topicId };
    await session.topics!.update({ address, title: "TOM-42 · Doing · Fix", closed: false });
    await session.topics!.update({ address, title: "TOM-42 · Verifying · Fix", closed: false });
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix", closed: true });
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix", closed: true });
    await session.topics!.update({ address, title: "TOM-42 · Doing · Fix", closed: false });
    expect(fake.where("chat.update").map(c => c.args.text)).toEqual(["TOM-42 · Verifying · Fix", "✅ TOM-42 · Done · Fix", "TOM-42 · Doing · Fix"]);
    expect(fake.find("C0DEV", topicId)).toMatchObject({ text: "TOM-42 · Doing · Fix", metadata: { event_type: "tomrade_topic" } });
  });

  it("opens no thread in a direct message, and reports Slack's refusals and limits as posting does", async () => {
    const { fake, session } = await connect();
    await expect(session.topics!.open({ operationId: "t0", address: { tenantId: "T0FAKE", conversationId: "D0ANN" }, title: TITLE }))
      .rejects.toMatchObject({ disposition: "permanent" });
    expect(fake.where("chat.postMessage")).toHaveLength(0);
    fake.failNext(c => c.method === "chat.postMessage", 429, "ratelimited", { retryAfter: 2 });
    await expect(session.topics!.open({ operationId: "t1", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 2000 });
    fake.failNext(c => c.method === "chat.postMessage", 500, "internal_error");
    await expect(session.topics!.open({ operationId: "t2", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "uncertain" });
    fake.failNext(c => c.method === "chat.postMessage", 200, "not_in_channel");
    await expect(session.topics!.open({ operationId: "t3", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    const { topicId } = await session.topics!.open({ operationId: "t4", address: room, title: TITLE });
    fake.failNext(c => c.method === "chat.update", 500, "internal_error");
    await expect(session.topics!.update({ address: { ...room, topicId }, title: "x", closed: false })).rejects.toMatchObject({ disposition: "retryable" });
    await expect(session.topics!.update({ address: { ...room, topicId: "1600000000.000001" }, title: "x", closed: false })).rejects.toMatchObject({ disposition: "permanent" });
  });
});

describe("streaming", () => {
  const stream = (session: ImAdapterSession) => session.stream!;

  it("streams into the asking message's thread and settles it as mrkdwn", async () => {
    const { fake, session, events } = await connect();
    const asked = fake.message({ channel: "C0DEV", user: "U0ANN", text: "go", mention: true });
    await until("the mention", () => events.length === 1);
    const d = delivery({ channel: "C0DEV", threadId: asked.ts, content: { text: "*Plan*" } });
    const { messageId } = await stream(session).start(d);
    expect(fake.where("chat.startStream")[0]!.args).toMatchObject({ channel: "C0DEV", thread_ts: asked.ts, markdown_text: "**Plan**", recipient_user_id: "U0ANN", recipient_team_id: "T0FAKE" });
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: " for <https://x.test|the guide> &amp; `a &lt; b`" });
    expect(fake.find("C0DEV", messageId)!.markdown).toBe("**Plan** for [the guide](https://x.test) &amp; `a < b`");
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "*Plan* is done", actions: [{ label: "More", token: "tk" }] } });
    const m = fake.find("C0DEV", messageId)!;
    expect(m.streaming).toBe(false);
    expect(fake.textOf(m)).toBe("*Plan* is done");
    expect(elements(m.blocks).map(e => e.value)).toEqual(["tk"]);
  });

  it("ends a stream complete even if Slack will not rewrite it", async () => {
    const { fake, session } = await connect();
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    fake.failNext(c => c.method === "chat.update", 200, "cant_update_message");
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello *there*" } });
    expect(fake.find("D0ANN", messageId)).toMatchObject({ streaming: false, markdown: "Hello **there**" });
  });

  it("grows a reply by edits where Slack will not stream", async () => {
    const fake = new FakeSlack();
    fake.noStream = true;
    const { session } = await connect(fake);
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.textOf(fake.find("D0ANN", messageId)!)).toBe("Hello");
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there" } });
    expect(fake.textOf(fake.find("D0ANN", messageId)!)).toBe("Hello there");
    expect(fake.where("chat.stopStream")).toHaveLength(0);
  });

  it("does not stream at the top of a direct message", async () => {
    const { fake, session } = await connect();
    const { messageId } = await stream(session).start(delivery({ channel: "D0ANN", content: { text: "Hi" } }));
    expect(fake.where("chat.startStream")).toHaveLength(0);
    expect(fake.find("D0ANN", messageId)!.thread).toBeUndefined();
  });

  it("settles a stream it started before a restart", async () => {
    const fake = new FakeSlack();
    const first = await connect(fake);
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Hel" } });
    const { messageId } = await stream(first.session).start(d);
    first.close();
    const second = await connect(fake);
    await stream(second.session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.find("D0ANN", messageId)).toMatchObject({ streaming: false });
    expect(fake.textOf(fake.find("D0ANN", messageId)!)).toBe("Hello");
  });

  it("finishes by edits once the person stopped the stream", async () => {
    const { fake, session } = await connect();
    const d = delivery({ channel: "D0ANN", topic: "1600000000.000001", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    fake.find("D0ANN", messageId)!.streaming = false;
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.textOf(fake.find("D0ANN", messageId)!)).toBe("Hello");
  });
});

describe("limits and indicators", () => {
  it("waits out a rate limit as long as Slack says", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "chat.postMessage", 429, "ratelimited", { retryAfter: 2 });
    await expect(session.deliver(delivery({ channel: "D0ANN" }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 2000 });
  });

  it("calls a lost post uncertain and a lost edit retryable", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "chat.postMessage", 500, "internal_error");
    await expect(session.deliver(delivery({ channel: "D0ANN" }))).rejects.toMatchObject({ disposition: "uncertain" });
    const { messageId } = await session.deliver(delivery({ channel: "D0ANN" }));
    fake.failNext(c => c.method === "chat.update", 500, "internal_error");
    await expect(session.deliver(delivery({ channel: "D0ANN", replaceMessageId: messageId }))).rejects.toMatchObject({ disposition: "retryable" });
    fake.failNext(c => c.method === "chat.postMessage", 200, "channel_not_found");
    await expect(session.deliver(delivery({ channel: "D0ANN" }))).rejects.toMatchObject({ disposition: "permanent" });
  });

  it("reacts and swaps the reaction for the outcome", async () => {
    const { fake, session } = await connect();
    const address = { tenantId: "T0FAKE", conversationId: "D0ANN", topicId: "1600000000.000009" };
    await session.react!({ address, messageId: "1600000000.000009", reaction: "received" });
    await session.react!({ address, messageId: "1600000000.000009", reaction: "done" });
    await session.react!({ address, messageId: "cmd:trig.1", reaction: "done" });
    expect(fake.reactions.map(r => [r.name, r.removed])).toEqual([["eyes", true], ["white_check_mark", false]]);
  });

  it("shows the assistant status in the thread and clears it", async () => {
    const { fake, session } = await connect();
    await session.indicate!({ address: { tenantId: "T0FAKE", conversationId: "C0DEV" }, threadId: "1600000000.000002@1600000000.000001", state: "typing" });
    await session.indicate!({ address: { tenantId: "T0FAKE", conversationId: "D0ANN", topicId: "1600000000.000003" }, state: "idle" });
    await session.indicate!({ address: { tenantId: "T0FAKE", conversationId: "D0ANN" }, state: "typing" });
    expect(fake.statuses).toEqual([{ channel: "C0DEV", thread: "1600000000.000001", status: "is thinking…" }, { channel: "D0ANN", thread: "1600000000.000003", status: "" }]);
  });

  it("asks a channel for the status once when Slack shows none there", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "assistant.threads.setStatus", 200, "method_not_supported_for_channel_type");
    const address = { tenantId: "T0FAKE", conversationId: "C0DEV" };
    await expect(session.indicate!({ address, threadId: "1600000000.000001", state: "typing" })).rejects.toThrow();
    await session.indicate!({ address, threadId: "1600000000.000001", state: "typing" });
    expect(fake.where("assistant.threads.setStatus")).toHaveLength(1);
  });
});

describe("using it in channels", () => {
  const TITLE = "TOM-42 · Doing · Fix the login page";
  const room = { tenantId: "T0FAKE", conversationId: "C0DEV" };

  it("shows its own steps for channels in IM settings, in English and Chinese", async () => {
    let adapter: ImAdapter | undefined;
    await plugin.apply({ im: { register: async (a: ImAdapter) => { adapter = a; return () => {}; } } } as never, undefined as never);
    const steps = adapter!.setup!.groupSteps! as { en: string; zh: string }[];
    expect(steps.length).toBe(3);
    expect(steps.every(s => s.en && s.zh)).toBe(true);
    expect(steps[0]!.en).toContain("/invite @");
  });

  it("says once per channel that the bot is not a member, and clears it once a post works there", async () => {
    const { fake, session, notices } = await connect();
    fake.failNext(c => c.method === "chat.postMessage", 200, "not_in_channel", { times: 2 });
    await expect(session.topics!.open({ operationId: "topic:1", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    await expect(session.deliver(delivery({ channel: "C0DEV" }))).rejects.toMatchObject({ code: "not_in_channel" });
    expect(notices).toEqual([{ key: "slack:C0DEV:member", address: room, text: { en: expect.stringContaining("`/invite @"), zh: expect.stringContaining("`/invite @") } }]);
    await session.topics!.open({ operationId: "topic:2", address: room, title: TITLE });
    expect(notices.at(-1)).toBe("clear:slack:C0DEV:member");
  });

  it("names the scope Slack says is missing, and says nothing for a direct message or another refusal", async () => {
    const { fake, session, notices } = await connect();
    fake.failNext(c => c.method === "reactions.add", 200, "missing_scope", { needed: "reactions:write" });
    await expect(session.react!({ address: room, messageId: "1700000000.000001", reaction: "received" })).rejects.toMatchObject({ code: "missing_scope" });
    fake.failNext(c => c.method === "chat.postMessage", 200, "not_in_channel");
    await expect(session.deliver(delivery({ channel: "D0ANN" }))).rejects.toBeDefined();
    fake.failNext(c => c.method === "chat.postMessage", 200, "msg_too_long");
    await expect(session.deliver(delivery({ channel: "C0DEV" }))).rejects.toBeDefined();
    expect(notices).toEqual([{ key: "slack:C0DEV:scope:reactions:write", address: room, text: { en: expect.stringContaining("`reactions:write` scope"), zh: expect.stringContaining("`reactions:write`") } }]);
  });
});
