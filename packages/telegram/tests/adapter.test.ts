import { afterEach, describe, expect, it } from "vitest";
import type { ImAdapter, ImAdapterSession, ImDelivery, ImInbound, ImNotice } from "@tomradex/plugin-sdk";
import { openTelegram } from "../src/adapter.js";
import { FakeTelegram } from "../src/fake.js";
import plugin from "../src/index.js";
import { ADMIN_RIGHTS, addToGroup, type TKeyboard } from "../src/wire.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

const GROUP = -100777;
const hex = (n: number) => n.toString(16).padStart(2, "0").repeat(24);

async function connect(fake = new FakeTelegram(), opts: { token?: string; outbound?: Record<string, Uint8Array>; receive?: (e: ImInbound) => Promise<unknown> } = {}) {
  const events: ImInbound[] = [];
  /** What the adapter told the host: notices, and `clear:<key>` once their cause went. */
  const notices: (ImNotice | string)[] = [];
  const states: string[] = [];
  const ac = new AbortController();
  const session = await openTelegram("c1", {
    signal: ac.signal,
    credentials: { botToken: opts.token ?? fake.token },
    receive: async e => {
      await opts.receive?.(e);
      // As the IM layer does once a connection is closed.
      if (ac.signal.aborted) throw new Error("IM connection is no longer active");
      events.push(e);
      return { receiptId: `r${events.length}` };
    },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array(),
    notice: n => { notices.push(n); },
    clearNotice: key => { notices.push(`clear:${key}`); }
  }, { net: fake.net(), backoffMs: 5, timeoutS: 1 });
  const handle = { fake, session, events, states, notices, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}

let ops = 0;
const delivery = (o: Partial<ImDelivery> & { chat: number; topic?: string }): ImDelivery => ({
  operationId: `op${++ops}`, address: { tenantId: "telegram", conversationId: String(o.chat), ...(o.topic ? { topicId: o.topic } : {}) },
  content: { text: "hello" }, ...o
});
const message = (events: ImInbound[], i = -1) => events.at(i) as ImInbound & { kind: "message" };
const buttons = (k: TKeyboard | undefined) => (k?.inline_keyboard ?? []).flat();

describe("connecting", () => {
  it("signs in as the bot and polls for what it reads", async () => {
    const { fake, session } = await connect();
    expect(session.identity).toEqual({ id: "123456789", name: "Tomrade Bot (@tomrade_bot)" });
    await until("a poll", () => fake.where("getUpdates").length > 0);
    expect(fake.where("getUpdates")[0]!.params).toMatchObject({ timeout: 1, allowed_updates: ["message", "edited_message", "callback_query"] });
  });

  it("refuses a wrong token in Telegram's words", async () => {
    await expect(connect(new FakeTelegram(), { token: "123456789:AAWrongTokenWrongTokenWrong" })).rejects.toThrow(/refused the bot token: Unauthorized/);
    await expect(connect(new FakeTelegram(), { token: "not a token" })).rejects.toThrow(/not a bot token/);
  });

  it("fails clearly when a webhook holds the bot, and leaves the webhook alone", async () => {
    const fake = new FakeTelegram();
    fake.webhook = "https://example.com/hook";
    await expect(connect(fake)).rejects.toThrow(/webhook/);
    expect(fake.where("deleteWebhook")).toHaveLength(0);
    expect(fake.where("getUpdates")).toHaveLength(0);
  });

  it("reconnects after network errors, with backoff, and says so", async () => {
    const { fake, events, states } = await connect();
    await until("a poll", () => fake.where("getUpdates").length === 1);
    fake.drop(2);
    await until("back", () => states.at(-1) === "connected");
    expect(states).toEqual(["connecting", "connected"]);
    // After a failure a short poll proves the way is open before the next long wait.
    expect(fake.where("getUpdates").map(c => c.params.timeout).slice(-2)).toEqual([0, 1]);
    fake.message({ from: fake.ann, text: "back" });
    await until("the message after the drop", () => events.length === 1);
  });

  it("stops polling when a webhook appears, as an error", async () => {
    const { fake, states } = await connect();
    await until("a poll", () => fake.where("getUpdates").length === 1);
    fake.webhook = "https://example.com/hook";
    fake.drop();
    await until("the error", () => states.includes("error"));
    const polls = fake.where("getUpdates").length;
    await new Promise(r => setTimeout(r, 50));
    expect(fake.where("getUpdates")).toHaveLength(polls);
  });

  it("waits out another reader without alarm at first", async () => {
    const { fake, states, events } = await connect();
    await until("a poll", () => fake.where("getUpdates").length === 1);
    // Another program's getUpdates ends this one.
    await fake.net().fetch(`https://api.telegram.org/bot${fake.token}/getUpdates`, { method: "POST", body: JSON.stringify({ timeout: 0 }) });
    await until("polling again", () => fake.where("getUpdates").length >= 3);
    expect(states).toEqual([]);
    fake.message({ from: fake.ann, text: "still here" });
    await until("the message", () => events.length === 1);
  });

  it("registers the commands for the bot's menu", async () => {
    const { fake, session } = await connect();
    await session.commands!([{ name: "status", description: "Show what the assistant is doing" }, { name: "answer", description: "Answer the open question", args: "token answer" }, { name: "Bad-Name", description: "x" }]);
    expect(fake.commands).toEqual([{ command: "status", description: "Show what the assistant is doing" }, { command: "answer", description: "Answer the open question (token answer)" }]);
  });
});

describe("offsets", () => {
  it("confirms an update only once the IM layer took it, and catches up after a restart without repeats", async () => {
    const fake = new FakeTelegram();
    const first = await connect(fake);
    const a = fake.message({ from: fake.ann, text: "one" });
    const b = fake.message({ from: fake.ann, text: "two" });
    await until("both", () => first.events.length === 2);
    first.close();
    await until("the offset confirmed on close", () => !fake.pending.some(u => u.update_id <= b.updateId));
    // Sent while Tomrade was closed: Telegram keeps them.
    fake.message({ from: fake.ann, text: "three" });
    fake.message({ from: fake.ann, text: "four" });
    const second = await connect(fake);
    await until("the catch-up", () => second.events.length === 2);
    await new Promise(r => setTimeout(r, 30));
    expect(second.events.map(e => (e as ImInbound & { kind: "message" }).text)).toEqual(["three", "four"]);
    expect(fake.served.filter(id => id === a.updateId || id === b.updateId)).toHaveLength(2);
    expect(message(first.events, 0).eventId).toBe(`m:${fake.ann.id}:${a.id}`);
  });

  it("keeps an update Telegram handed over but the IM layer did not take before closing", async () => {
    const fake = new FakeTelegram();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let n = 0;
    // Both wait at Telegram, so the first poll hands them over together.
    fake.message({ from: fake.ann, text: "taken" });
    const late = fake.message({ from: fake.ann, text: "late" });
    const first = await connect(fake, { receive: async () => { if (++n === 2) await held; } });
    await until("the second being taken", () => n === 2);
    first.close();
    release();
    // Closing tells Telegram the first was taken; the second stays.
    await until("the first confirmed", () => fake.pending[0]?.update_id === late.updateId);
    expect(fake.pending).toHaveLength(1);
    const second = await connect(fake);
    await until("the late one again", () => second.events.length === 1);
    expect(message(second.events).text).toBe("late");
  });

  it("gives a message the same event id whichever update carries it", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ from: fake.ann, text: "once" });
    fake.redeliver(sent.message);
    await until("both updates", () => events.length === 2);
    expect(events[0]!.eventId).toBe(events[1]!.eventId);
  });
});

describe("receiving", () => {
  it("takes a direct message with its sender's name", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ from: fake.ann, text: "hello" });
    await until("the message", () => events.length === 1);
    expect(message(events)).toEqual({ kind: "message", eventId: `m:1001:${sent.id}`, messageId: String(sent.id), text: "hello", activation: "dm",
      actor: { id: "1001", name: "Ann Lee", isBot: false }, address: { tenantId: "telegram", conversationId: "1001" } });
  });

  it("answers Telegram's bare /start with the commands", async () => {
    const { fake, events } = await connect();
    fake.message({ from: fake.ann, text: "/start" });
    fake.message({ from: fake.ann, text: "/start TOM-12" });
    fake.message({ from: fake.ann, chat: GROUP, text: "/start@tomrade_bot" });
    await until("all three", () => events.length === 3);
    expect(events.map(e => (e as ImInbound & { kind: "message" }).text)).toEqual(["/help", "/start TOM-12", "/help"]);
  });

  it("in a group, tells an @, a command, a reply and chatter apart", async () => {
    const { fake, session, events } = await connect();
    fake.message({ from: fake.ann, chat: GROUP, text: "chatter" });
    const asked = fake.message({ from: fake.ann, chat: GROUP, text: "@tomrade_bot help me" });
    fake.message({ from: fake.ann, chat: GROUP, text: "/status@tomrade_bot" });
    fake.message({ from: fake.ann, chat: GROUP, text: "/status@other_bot" });
    fake.message({ from: fake.ann, chat: GROUP, text: "/new" });
    await until("four", () => events.length === 4);
    expect(events.map(e => [(e as ImInbound & { kind: "message" }).activation, (e as ImInbound & { kind: "message" }).text]))
      .toEqual([["ambient", "chatter"], ["mention", "help me"], ["mention", "/status"], ["mention", "/new"]]);
    expect(message(events, 1).address).toEqual({ tenantId: "telegram", conversationId: String(GROUP) });

    const { messageId } = await session.deliver(delivery({ chat: GROUP, replyTo: String(asked.id), content: { text: "<b>sure</b>" } }));
    expect(fake.where("sendMessage").at(-1)!.params).toMatchObject({ parse_mode: "HTML", reply_parameters: { message_id: asked.id, allow_sending_without_reply: true } });
    expect(fake.where("sendMessage").at(-1)!.params).not.toHaveProperty("message_thread_id");
    fake.message({ from: fake.bob, chat: GROUP, text: "and this?", replyTo: Number(messageId) });
    await until("the reply", () => events.length === 5);
    expect(message(events)).toMatchObject({ activation: "reply", replyTo: messageId, context: [{ role: "quoted", text: "sure", author: { id: "123456789", isBot: true } }] });
  });

  it("keeps a forum topic's messages together and answers in the topic", async () => {
    const { fake, session, events } = await connect();
    const topic = fake.topic(GROUP, "Release planning");
    fake.message({ from: fake.ann, chat: GROUP, topic, text: "@tomrade_bot what's left?" });
    await until("the topic message", () => events.length === 1);
    expect(message(events)).toMatchObject({ activation: "mention", address: { conversationId: String(GROUP), topicId: String(topic) },
      context: [{ role: "root", text: "Release planning", author: { id: "1001" } }] });
    expect(message(events)).not.toHaveProperty("replyTo");
    await session.deliver(delivery({ chat: GROUP, topic: String(topic), threadId: String(topic) }));
    expect(fake.where("sendMessage").at(-1)!.params).toMatchObject({ message_thread_id: topic });
    await session.indicate!({ address: { tenantId: "telegram", conversationId: String(GROUP), topicId: String(topic) }, threadId: String(topic), state: "typing" });
    expect(fake.actions).toEqual([{ chat: GROUP, action: "typing", thread: topic }]);
  });

  it("keeps code and links, and drops its own @", async () => {
    const { fake, events } = await connect();
    const text = "😀 @tomrade_bot run npm test then see docs\nconst x = 1";
    fake.message({ from: fake.ann, chat: GROUP, text, entities: [
      { type: "mention", offset: 3, length: 12 }, { type: "code", offset: 20, length: 8 }, { type: "text_link", offset: 38, length: 4, url: "https://x.test/d" }, { type: "pre", offset: 43, length: 11, language: "js" }] });
    await until("the message", () => events.length === 1);
    expect(message(events).text).toBe("😀 run `npm test` then see [docs](https://x.test/d)\n```js\nconst x = 1\n```");
  });

  it("hands over a photo and a document with their sizes, and fetches them", async () => {
    const fake = new FakeTelegram();
    fake.files.set("ph1", { bytes: new Uint8Array([1, 2, 3]), size: 3 });
    fake.files.set("doc1", { bytes: new Uint8Array([9, 9]), size: 2 });
    const { session, events } = await connect(fake);
    const p = fake.message({ from: fake.ann, caption: "look", photo: { id: "ph1", size: 3 } });
    fake.message({ from: fake.ann, document: { file_id: "doc1", file_name: "spec.pdf", mime_type: "application/pdf" } });
    await until("both", () => events.length === 2);
    expect(message(events, 0)).toMatchObject({ text: "look", attachments: [{ id: "ph1", name: `photo-${p.id}.jpg`, mimeType: "image/jpeg", size: 3 }] });
    // No size in the message: getFile tells it.
    expect(message(events, 1)).toMatchObject({ text: "", attachments: [{ id: "doc1", name: "spec.pdf", mimeType: "application/pdf", size: 2 }] });
    expect([...await session.download!(message(events, 0).attachments![0]!)]).toEqual([1, 2, 3]);
  });

  it("names a file too large for a bot to fetch instead of handing it over", async () => {
    const fake = new FakeTelegram();
    fake.files.set("big", { bytes: new Uint8Array(), size: 40 * 1024 * 1024 });
    const { events } = await connect(fake);
    fake.message({ from: fake.ann, caption: "here", document: { file_id: "big", file_name: "dump.zip", file_size: 40 * 1024 * 1024 } });
    await until("the message", () => events.length === 1);
    expect(message(events)).toMatchObject({ text: "here\n[dump.zip, 40 MB: too large for a Telegram bot to fetch]" });
    expect(message(events).attachments).toBeUndefined();
  });

  it("reports a real edit of a message it handed over, and nothing else", async () => {
    const { fake, events } = await connect();
    const sent = fake.message({ from: fake.ann, text: "draft" });
    await until("the message", () => events.length === 1);
    fake.edit(fake.ann.id, sent.id, "draft");
    fake.edit(fake.ann.id, sent.id, "final");
    await until("the edit", () => events.length === 2);
    expect(events[1]).toMatchObject({ kind: "edit", messageId: String(sent.id), actor: { id: "1001" } });
  });

  it("ignores bots", async () => {
    const { fake, events } = await connect();
    fake.message({ from: { id: 55, is_bot: true, first_name: "Other" }, chat: GROUP, text: "@tomrade_bot hi" });
    const after = fake.message({ from: fake.ann, text: "me" });
    await until("the person's", () => events.length === 1);
    expect(message(events).messageId).toBe(String(after.id));
  });
});

describe("cards and buttons", () => {
  it("answers a button at once and passes its token on", async () => {
    const { fake, session, events } = await connect();
    const token = hex(1);
    fake.forums.add(GROUP);
    const { messageId } = await session.deliver(delivery({ chat: GROUP, topic: "9", content: { text: "Ship it?", actions: [{ label: "Yes", token, style: "primary" }, { label: "No", token: hex(2) }] } }));
    const posted = fake.posted(GROUP)[0]!;
    expect(buttons(posted.reply_markup).map(b => [b.text, b.style])).toEqual([["Yes", "primary"], ["No", undefined]]);
    expect(buttons(posted.reply_markup).every(b => Buffer.byteLength(b.callback_data!) <= 64)).toBe(true);
    const press = fake.press({ chat: GROUP, messageId: Number(messageId), from: fake.bob, label: "Yes" });
    await until("the action", () => events.length === 1);
    expect(fake.answers.get(press)!.at).toBeDefined();
    expect(events[0]).toEqual({ kind: "action", eventId: `c:${press}`, token, actor: { id: "1002", name: "Bob", isBot: false }, address: { tenantId: "telegram", conversationId: String(GROUP), topicId: "9" } });
  });

  it("passes a select's value on", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ chat: fake.ann.id, content: { text: "Which agent?", elements: [{ type: "select", token: hex(3), placeholder: "Agent", options: [{ label: "Claude Code", value: "claude-code" }, { label: "Codex", value: "codex" }] }] } }));
    expect(buttons(fake.posted(fake.ann.id)[0]!.reply_markup).map(b => b.text)).toEqual(["Agent", "Claude Code", "Codex"]);
    const label = fake.press({ chat: fake.ann.id, messageId: Number(messageId), from: fake.ann, label: "Agent" });
    fake.press({ chat: fake.ann.id, messageId: Number(messageId), from: fake.ann, label: "Codex" });
    await until("the action", () => events.length === 1);
    expect(fake.answers.get(label)!.at).toBeDefined();
    expect(events[0]).toMatchObject({ kind: "action", token: hex(3), value: "codex" });
  });

  it("ticks a multi-select's options and passes them on when submitted", async () => {
    const { fake, session, events } = await connect();
    const chat = fake.ann.id;
    const { messageId } = await session.deliver(delivery({ chat, content: { text: "Which?", elements: [{ type: "select", token: hex(4), multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }] }] } }));
    const id = Number(messageId);
    const empty = fake.press({ chat, messageId: id, from: fake.ann, label: "Submit" });
    await until("a hint", () => fake.answers.get(empty)?.text === "Pick at least one");
    fake.press({ chat, messageId: id, from: fake.ann, label: "C" });
    fake.press({ chat, messageId: id, from: fake.ann, label: "A" });
    await until("two ticks", () => buttons(fake.posted(chat)[0]!.reply_markup).filter(b => b.text.startsWith("✅")).length === 2);
    fake.press({ chat, messageId: id, from: fake.ann, label: "C" });
    await until("one tick", () => buttons(fake.posted(chat)[0]!.reply_markup).filter(b => b.text.startsWith("✅")).length === 1);
    expect(events).toHaveLength(0);
    fake.press({ chat, messageId: id, from: fake.ann, label: "Submit" });
    await until("the action", () => events.length === 1);
    expect(events[0]).toMatchObject({ kind: "action", token: hex(4), value: ["a"] });
  });

  it("reads a multi-select from its keyboard after a restart", async () => {
    const fake = new FakeTelegram();
    const first = await connect(fake);
    const chat = fake.ann.id;
    const { messageId } = await first.session.deliver(delivery({ chat, content: { text: "Which?", elements: [{ type: "select", token: hex(5), multiple: true, options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] } }));
    fake.press({ chat, messageId: Number(messageId), from: fake.ann, label: "B" });
    await until("a tick", () => buttons(fake.posted(chat)[0]!.reply_markup).some(b => b.text === "✅ B"));
    first.close();
    const second = await connect(fake);
    fake.press({ chat, messageId: Number(messageId), from: fake.ann, label: "A" });
    await until("two ticks", () => buttons(fake.posted(chat)[0]!.reply_markup).filter(b => b.text.startsWith("✅")).length === 2);
    fake.press({ chat, messageId: Number(messageId), from: fake.ann, label: "Submit" });
    await until("the action", () => second.events.length === 1);
    expect(second.events[0]).toMatchObject({ token: hex(5), value: ["A", "B"] });
  });

  it("asks for a written answer with a reply prompt, and takes the reply as the answer", async () => {
    const { fake, session, events } = await connect();
    const { messageId } = await session.deliver(delivery({ chat: GROUP, content: { text: "Anything else?", elements: [{ type: "input", token: hex(6), label: "Your answer" }] } }));
    const press = fake.press({ chat: GROUP, messageId: Number(messageId), from: fake.bob, label: "Your answer" });
    await until("the prompt", () => fake.posted(GROUP).length === 2);
    expect(fake.answers.get(press)!.at).toBeDefined();
    const prompt = fake.posted(GROUP)[1]!;
    expect(prompt.text).toBe("Bob ✍️ Your answer");
    expect(fake.where("sendMessage").at(-1)!.params).toMatchObject({ reply_markup: { force_reply: true, selective: true, input_field_placeholder: "回复这条消息作答" },
      reply_parameters: { message_id: Number(messageId) } });
    const reply = fake.message({ from: fake.bob, chat: GROUP, text: "ship on Friday", replyTo: prompt.message_id });
    await until("the answer", () => events.length === 1);
    expect(events[0]).toEqual({ kind: "action", eventId: `m:${GROUP}:${reply.id}`, token: hex(6), value: "ship on Friday", actor: { id: "1002", name: "Bob", isBot: false }, address: { tenantId: "telegram", conversationId: String(GROUP) } });
    await until("the prompt cleared away", () => fake.posted(GROUP).length === 1);
  });

  it("takes a reply to the card itself as the written answer, even after a restart", async () => {
    const fake = new FakeTelegram();
    const first = await connect(fake);
    const { messageId } = await first.session.deliver(delivery({ chat: fake.ann.id, content: { text: "What should change?", elements: [{ type: "input", token: hex(7), label: "What should change" }] } }));
    first.close();
    const second = await connect(fake);
    fake.message({ from: fake.ann, text: "/status", replyTo: Number(messageId) });
    fake.message({ from: fake.ann, text: "smaller steps", replyTo: Number(messageId) });
    await until("both", () => second.events.length === 2);
    expect(second.events[0]).toMatchObject({ kind: "message", text: "/status" });
    expect(second.events[1]).toMatchObject({ kind: "action", token: hex(7), value: "smaller steps" });
  });

  it("renders a ticket card: sections, web links as buttons, app links as text", async () => {
    const { fake, session } = await connect();
    await session.deliver(delivery({ chat: fake.ann.id, content: { text: "Saved <a href=\"tomrade://file/p/f1\">notes.md</a>", elements: [
      { type: "section", title: "Created · TOM-12 Fix <login>", fields: [{ label: "Status", value: "Doing" }, { label: "Pull request", value: "#34 · Open" }] },
      { type: "section", title: "Checks", text: "- **lint** ok\n- tests" },
      { type: "links", links: [{ label: "Pull request #34", url: "https://github.com/o/r/pull/34" }, { label: "Open in Tomrade", url: "tomrade://item/p/TOM-12" }] }] } }));
    const posted = fake.posted(fake.ann.id)[0]!;
    expect(posted.text).toBe("Saved notes.md\n\nCreated · TOM-12 Fix <login>\nStatus: Doing\nPull request: #34 · Open\n\nChecks\n• lint ok\n• tests\n\nOpen in Tomrade: tomrade://item/p/TOM-12");
    expect(posted.html).toContain("<b>Created · TOM-12 Fix &lt;login&gt;</b>");
    expect(buttons(posted.reply_markup)).toEqual([{ text: "Pull request #34", url: "https://github.com/o/r/pull/34" }]);
  });

  it("edits a card in place, takes its buttons away, and shrugs off an edit that changes nothing", async () => {
    const { fake, session } = await connect();
    const d = delivery({ chat: fake.ann.id, content: { text: "Ship it?", actions: [{ label: "Yes", token: hex(8) }] } });
    const { messageId } = await session.deliver(d);
    await session.deliver({ ...d, operationId: "e1", replaceMessageId: messageId, content: { text: "Question handled or expired" } });
    expect(fake.posted(fake.ann.id)[0]).toMatchObject({ text: "Question handled or expired" });
    expect(fake.posted(fake.ann.id)[0]!.reply_markup).toBeUndefined();
    await expect(session.deliver({ ...d, operationId: "e2", replaceMessageId: messageId, content: { text: "Question handled or expired" } })).resolves.toEqual({ messageId });
    expect(fake.posted(fake.ann.id)).toHaveLength(1);
  });

  it("falls back to plain text when Telegram cannot parse the HTML", async () => {
    const { fake, session } = await connect();
    await session.deliver(delivery({ chat: fake.ann.id, content: { text: "a <blink>b</blink> &amp; c" } }));
    expect(fake.posted(fake.ann.id)[0]).toMatchObject({ text: "a b & c" });
    expect(fake.where("sendMessage").at(-1)!.params).not.toHaveProperty("parse_mode");
  });

  it("never posts a part twice when a delivery is retried", async () => {
    const { fake, session } = await connect(new FakeTelegram(), { outbound: { f1: new Uint8Array(5) } });
    fake.failNext(c => c.method === "sendDocument", 500, "Internal Server Error");
    const d = delivery({ chat: fake.ann.id, content: { text: "the report", files: [{ id: "f1", name: "r.pdf", mimeType: "application/pdf", size: 5 }] } });
    await expect(session.deliver(d)).rejects.toMatchObject({ disposition: "uncertain" });
    const { messageId } = await session.deliver(d);
    expect(fake.posted(fake.ann.id).map(m => m.file?.name ?? m.text)).toEqual(["the report", "r.pdf"]);
    expect(messageId).toBe(String(fake.posted(fake.ann.id)[0]!.message_id));
  });
});

describe("files out", () => {
  it("sends images as photos and other files as documents, after the text", async () => {
    const { fake, session } = await connect(new FakeTelegram(), { outbound: { f1: new Uint8Array(10), f2: new Uint8Array(20) } });
    await session.deliver(delivery({ chat: fake.ann.id, replyTo: "77", content: { text: "files", files: [{ id: "f1", name: "a.png", mimeType: "image/png", size: 10 }, { id: "f2", name: "spec.pdf", mimeType: "application/pdf", size: 20 }] } }));
    expect(fake.posted(fake.ann.id).map(m => m.file?.field ?? "text")).toEqual(["text", "photo", "document"]);
    expect(fake.where("sendDocument")[0]!.params).toMatchObject({ chat_id: String(fake.ann.id), document: { name: "spec.pdf", size: 20, type: "application/pdf" } });
    expect(fake.where("sendPhoto")[0]!.params).not.toHaveProperty("reply_parameters");
  });

  it("sends a photo Telegram refuses as a document", async () => {
    const fake = new FakeTelegram();
    fake.refusePhotos = true;
    const { session } = await connect(fake, { outbound: { f1: new Uint8Array(10) } });
    await session.deliver(delivery({ chat: fake.ann.id, content: { text: "", files: [{ id: "f1", name: "wide.png", mimeType: "image/png", size: 10 }] } }));
    expect(fake.posted(fake.ann.id).map(m => m.file?.field)).toEqual(["document"]);
  });
});

describe("streaming", () => {
  const stream = (session: ImAdapterSession) => session.stream!;

  it("grows a direct reply as a draft and sends the final message", async () => {
    const { fake, session } = await connect();
    const d = delivery({ chat: fake.ann.id, content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    expect(messageId).toMatch(/^draft:\d+$/);
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.drafts.map(x => x.text)).toEqual(["Hel", "Hello"]);
    expect(new Set(fake.drafts.map(x => x.draft)).size).toBe(1);
    expect(fake.posted(fake.ann.id)).toHaveLength(0);
    const done = await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there", actions: [{ label: "More", token: hex(9) }] } });
    const final = fake.posted(fake.ann.id);
    expect(final).toHaveLength(1);
    expect(done.messageId).toBe(String(final[0]!.message_id));
    expect(final[0]).toMatchObject({ text: "Hello there" });
    expect(buttons(final[0]!.reply_markup).map(b => b.text)).toEqual(["More"]);
  });

  it("grows a group reply by editing one message, quoting what asked", async () => {
    const { fake, session } = await connect();
    const d = delivery({ chat: GROUP, replyTo: "41", content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    expect(fake.drafts).toHaveLength(0);
    expect(fake.where("sendMessage")[0]!.params).toMatchObject({ reply_parameters: { message_id: 41 } });
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.posted(GROUP)[0]).toMatchObject({ text: "Hello" });
    await stream(session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello there" } });
    expect(fake.posted(GROUP).map(m => m.text)).toEqual(["Hello there"]);
  });

  it("falls back to edits when drafts are refused", async () => {
    const fake = new FakeTelegram();
    fake.noDrafts = true;
    const { session } = await connect(fake);
    const d = delivery({ chat: fake.ann.id, content: { text: "Hel" } });
    const { messageId } = await stream(session).start(d);
    expect(messageId).toBe(String(fake.posted(fake.ann.id)[0]!.message_id));
    await stream(session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    expect(fake.posted(fake.ann.id)[0]).toMatchObject({ text: "Hello" });
    await stream(session).start(delivery({ chat: fake.ann.id, content: { text: "Next" } }));
    expect(fake.where("sendMessageDraft")).toHaveLength(1);
  });

  it("settles a draft from before a restart with a new message", async () => {
    const fake = new FakeTelegram();
    const first = await connect(fake);
    const d = delivery({ chat: fake.ann.id, content: { text: "Hel" } });
    const { messageId } = await stream(first.session).start(d);
    first.close();
    const second = await connect(fake);
    await stream(second.session).append({ operationId: "a1", address: d.address, messageId, delta: "lo" });
    await stream(second.session).stop({ operationId: "s1", address: d.address, messageId, content: { text: "Hello" } });
    expect(fake.posted(fake.ann.id).map(m => m.text)).toEqual(["Hello"]);
  });
});

describe("limits", () => {
  it("waits out a rate limit as long as Telegram says", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "sendMessage", 429, "Too Many Requests: retry after 7", { retryAfter: 7 });
    await expect(session.deliver(delivery({ chat: fake.ann.id }))).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 7000 });
  });

  it("paces a group at 20 messages a minute", async () => {
    const { fake, session } = await connect();
    for (let i = 0; i < 20; i++) await session.deliver(delivery({ chat: GROUP, content: { text: `m${i}` } }));
    const err = await session.deliver(delivery({ chat: GROUP })).then(() => null, (e: unknown) => e as { disposition: string; retryAfterMs: number });
    expect(err).toMatchObject({ disposition: "retryable" });
    expect(err!.retryAfterMs).toBeGreaterThan(50_000);
    expect(fake.posted(GROUP)).toHaveLength(20);
    await session.deliver(delivery({ chat: fake.ann.id }));
  });

  it("calls a lost answer to a new message uncertain, and to an edit retryable", async () => {
    const { fake, session } = await connect();
    const { messageId } = await session.deliver(delivery({ chat: fake.ann.id }));
    fake.drop(1);
    await expect(session.deliver(delivery({ chat: fake.ann.id }))).rejects.toMatchObject({ disposition: "uncertain" });
    fake.drop(1);
    await expect(session.deliver(delivery({ chat: fake.ann.id, replaceMessageId: messageId, content: { text: "changed" } }))).rejects.toMatchObject({ disposition: "retryable" });
  });

  it("refuses for good what Telegram refuses", async () => {
    const { fake, session } = await connect();
    fake.failNext(c => c.method === "sendMessage", 403, "Forbidden: bot was blocked by the user");
    await expect(session.deliver(delivery({ chat: fake.ann.id }))).rejects.toMatchObject({ disposition: "permanent" });
  });

  it("reacts, swapping the reaction for the outcome", async () => {
    const { fake, session } = await connect();
    const address = { tenantId: "telegram", conversationId: String(fake.ann.id) };
    await session.react!({ address, messageId: "9", reaction: "received" });
    expect(fake.reactions.get(`${fake.ann.id}:9`)).toBe("👀");
    await session.react!({ address, messageId: "9", reaction: "done" });
    await session.react!({ address, messageId: "9", reaction: "done" });
    expect(fake.reactions.get(`${fake.ann.id}:9`)).toBe("👍");
    expect(fake.where("setMessageReaction")).toHaveLength(2);
  });
});


describe("ticket topics", () => {
  const TITLE = "TOM-42 · Doing · Fix the login page";
  const group = { tenantId: "telegram", conversationId: String(GROUP) };
  const forum = async () => {
    const fake = new FakeTelegram();
    fake.forums.add(GROUP);
    return connect(fake);
  };

  it("opens a topic in a forum, and what people write in it arrives with its topicId", async () => {
    const { fake, session, events } = await forum();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: TITLE });
    expect(fake.where("createForumTopic")[0]!.params).toEqual({ chat_id: GROUP, name: TITLE });
    // The topic's id is its opening message's, the message_thread_id of everything in it.
    expect(fake.messages.get(`${GROUP}:${topicId}`)).toMatchObject({ message_thread_id: Number(topicId), forum_topic_created: { name: TITLE } });
    expect(fake.topics.get(`${GROUP}:${topicId}`)).toEqual({ name: TITLE, closed: false });
    fake.message({ from: fake.ann, chat: GROUP, topic: Number(topicId), text: "@tomrade_bot what is left?" });
    await until("the topic's message", () => events.length === 1);
    expect(message(events)).toMatchObject({ text: "what is left?", address: { ...group, topicId }, context: [{ role: "root", text: TITLE, author: { id: "123456789" } }] });
  });

  it("delivers into the topic", async () => {
    const { fake, session } = await forum();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: TITLE });
    const { messageId } = await session.deliver(delivery({ chat: GROUP, topic: topicId, content: { text: "TOM-42 moved to Doing" } }));
    expect(fake.where("sendMessage").at(-1)!.params).toMatchObject({ chat_id: GROUP, message_thread_id: Number(topicId) });
    expect(fake.posted(GROUP).find(m => String(m.message_id) === messageId)).toMatchObject({ message_thread_id: Number(topicId), is_topic_message: true });
    await session.deliver(delivery({ chat: GROUP, threadId: topicId }));
    expect(fake.where("sendMessage").at(-1)!.params).toMatchObject({ message_thread_id: Number(topicId) });
  });

  it("clips a long name to Telegram's 128 characters", async () => {
    const { fake, session } = await forum();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: `TOM-42 · Doing · ${"x".repeat(200)}` });
    const name = fake.topics.get(`${GROUP}:${topicId}`)!.name;
    expect([...name]).toHaveLength(128);
    expect(name.endsWith("…")).toBe(true);
  });

  it("renames only when the name changes, and closes and reopens only when that changes", async () => {
    const { fake, session } = await forum();
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: TITLE });
    const address = { ...group, topicId };
    await session.topics!.update({ address, title: TITLE, closed: false });
    expect(fake.calls.filter(c => /ForumTopic$/.test(c.method) && c.method !== "createForumTopic")).toHaveLength(0);
    await session.topics!.update({ address, title: "TOM-42 · Verifying · Fix the login page", closed: false });
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true });
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true });
    await session.topics!.update({ address, title: "TOM-42 · Doing · Fix the login page", closed: false });
    const thread = Number(topicId);
    expect(fake.calls.filter(c => /^(edit|close|reopen)ForumTopic$/.test(c.method)).map(c => [c.method, c.params])).toEqual([
      ["editForumTopic", { chat_id: GROUP, message_thread_id: thread, name: "TOM-42 · Verifying · Fix the login page" }],
      ["editForumTopic", { chat_id: GROUP, message_thread_id: thread, name: "TOM-42 · Done · Fix the login page" }],
      ["closeForumTopic", { chat_id: GROUP, message_thread_id: thread }],
      ["reopenForumTopic", { chat_id: GROUP, message_thread_id: thread }],
      ["editForumTopic", { chat_id: GROUP, message_thread_id: thread, name: TITLE }]
    ]);
    expect(fake.topics.get(`${GROUP}:${topicId}`)).toEqual({ name: TITLE, closed: false });
  });

  it("after a restart, takes Telegram's \"not modified\" as done", async () => {
    const fake = new FakeTelegram();
    const topic = fake.topic(GROUP, "TOM-42 · Done · Fix the login page");
    fake.topics.get(`${GROUP}:${topic}`)!.closed = true;
    const { session } = await connect(fake);
    const address = { ...group, topicId: String(topic) };
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true });
    expect(fake.calls.filter(c => /^(edit|close)ForumTopic$/.test(c.method)).map(c => c.method)).toEqual(["editForumTopic", "closeForumTopic"]);
    fake.failNext(c => c.method === "reopenForumTopic", 400, "Bad Request: TOPIC_NOT_MODIFIED");
    await session.topics!.update({ address, title: "TOM-42 · Doing · Fix the login page", closed: false });
    expect(fake.topics.get(`${GROUP}:${topic}`)).toEqual({ name: "TOM-42 · Doing · Fix the login page", closed: true });
  });

  it("opens none in a direct chat, and a group that is not a forum refuses for good", async () => {
    const { fake, session } = await connect();
    await expect(session.topics!.open({ operationId: "topic:1", address: { tenantId: "telegram", conversationId: String(fake.ann.id) }, title: TITLE }))
      .rejects.toMatchObject({ disposition: "permanent" });
    expect(fake.where("createForumTopic")).toHaveLength(0);
    await expect(session.topics!.open({ operationId: "topic:2", address: group, title: TITLE })).rejects.toMatchObject({ disposition: "permanent", description: "Bad Request: the chat is not a forum" });
  });

  it("maps Telegram's errors as sending does", async () => {
    const { fake, session } = await forum();
    fake.failNext(c => c.method === "createForumTopic", 429, "Too Many Requests: retry after 3", { retryAfter: 3 });
    await expect(session.topics!.open({ operationId: "topic:1", address: group, title: TITLE })).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 3000 });
    fake.failNext(c => c.method === "createForumTopic", 400, "Bad Request: not enough rights to create a topic");
    await expect(session.topics!.open({ operationId: "topic:1", address: group, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    // A topic whose answer was lost may exist: uncertain, so it is not opened twice.
    fake.drop(1);
    await expect(session.topics!.open({ operationId: "topic:1", address: group, title: TITLE })).rejects.toMatchObject({ disposition: "uncertain" });
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: TITLE });
    const address = { ...group, topicId };
    fake.failNext(c => c.method === "editForumTopic", 502, "Bad Gateway");
    await expect(session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true })).rejects.toMatchObject({ disposition: "retryable" });
    fake.drop(1);
    await expect(session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true })).rejects.toMatchObject({ disposition: "retryable" });
    fake.failNext(c => c.method === "closeForumTopic", 400, "Bad Request: CHAT_ADMIN_REQUIRED");
    await expect(session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true })).rejects.toMatchObject({ disposition: "permanent" });
    // The rename went through before the refusal, so only the close is tried again.
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true });
    expect(fake.where("editForumTopic").map(c => c.params.name)).toEqual(Array(3).fill("TOM-42 · Done · Fix the login page"));
    expect(fake.topics.get(`${GROUP}:${topicId}`)).toEqual({ name: "TOM-42 · Done · Fix the login page", closed: true });
  });
});

describe("using it in a group", () => {
  const TITLE = "TOM-42 · Doing · Fix the login page";
  const group = { tenantId: "telegram", conversationId: String(GROUP) };

  it("offers a link that adds the bot to a group as an admin with exactly the rights it uses", async () => {
    const { session } = await connect();
    const url = new URL(session.links![0]!.url);
    expect(url.origin + url.pathname).toBe("https://t.me/tomrade_bot");
    expect(Object.fromEntries(url.searchParams)).toEqual({ startgroup: "tomrade", admin: "manage_topics" });
    expect(url.searchParams.get("admin")!.split(" ")).toEqual(ADMIN_RIGHTS.map(([right]) => right));
    expect(session.links![0]).toEqual({ label: { en: "Add the bot to a group", zh: "把机器人加到群" }, url: addToGroup("tomrade_bot") });
  });

  it("shows its own steps for a group in IM settings, in English and Chinese", async () => {
    let adapter: ImAdapter | undefined;
    await plugin.apply({ im: { register: async (a: ImAdapter) => { adapter = a; return () => {}; } } } as never, undefined as never);
    const steps = adapter!.setup!.groupSteps! as { en: string; zh: string }[];
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.every(s => s.en && s.zh)).toBe(true);
    expect(steps[0]!.en).toContain("Add the bot to a group");
  });

  it("says once per group that it has no Topics, and nothing more until topics work there", async () => {
    const { fake, session, notices } = await connect();
    for (const op of ["topic:1", "topic:2"]) await expect(session.topics!.open({ operationId: op, address: group, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    expect(notices).toEqual([{ key: `topics:${GROUP}:forum`, address: group, link: { label: { en: "Add the bot to a group", zh: "把机器人加到群" }, url: addToGroup("tomrade_bot") },
      text: { en: expect.stringContaining("turn on **Topics**"), zh: expect.stringContaining("开启 **话题（Topics）**") } }]);
    fake.forums.add(GROUP);
    await session.topics!.open({ operationId: "topic:3", address: group, title: TITLE });
    expect(notices.at(-1)).toBe(`clear:topics:${GROUP}:forum`);
  });

  it("says once per group when the bot lacks Manage Topics, opening or closing one", async () => {
    const { fake, session, notices } = await connect();
    fake.forums.add(GROUP);
    const { topicId } = await session.topics!.open({ operationId: "topic:1", address: group, title: TITLE });
    fake.failNext(c => /ForumTopic$/.test(c.method), 400, "Bad Request: not enough rights to manage topics", { times: 2 });
    await expect(session.topics!.update({ address: { ...group, topicId }, title: TITLE, closed: true })).rejects.toBeDefined();
    await expect(session.topics!.open({ operationId: "topic:2", address: group, title: TITLE })).rejects.toBeDefined();
    expect(notices.filter(n => typeof n !== "string")).toMatchObject([{ key: `topics:${GROUP}:rights`, text: { en: expect.stringContaining("**Manage Topics**") } }]);
  });

  it("says nothing for a direct chat or another refusal", async () => {
    const { fake, session, notices } = await connect();
    await expect(session.topics!.open({ operationId: "topic:1", address: { tenantId: "telegram", conversationId: String(fake.ann.id) }, title: TITLE })).rejects.toBeDefined();
    fake.forums.add(GROUP);
    fake.failNext(c => c.method === "createForumTopic", 400, "Bad Request: TOPIC_TITLE_INVALID");
    await expect(session.topics!.open({ operationId: "topic:2", address: group, title: TITLE })).rejects.toBeDefined();
    expect(notices).toEqual([]);
  });
});

describe("naming conversations", () => {
  it("names a group by its title and a direct chat by the person in it", async () => {
    const { fake, session } = await connect();
    expect(await session.describe!({ tenantId: "telegram", conversationId: String(GROUP) })).toEqual({ name: "Team" });
    expect(await session.describe!({ tenantId: "telegram", conversationId: String(fake.ann.id) })).toEqual({ name: "Ann Lee" });
    expect(await session.describe!({ tenantId: "telegram", conversationId: "4242" })).toBeNull();
  });
});

