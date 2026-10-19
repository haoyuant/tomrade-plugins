import { afterEach, describe, expect, it } from "vitest";
import { ImDeliveryError, resolveImCapabilities, type ImDelivery, type ImInbound } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openDiscord } from "../src/adapter.js";
import { FakeDiscord } from "../src/fake.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

const OWNER = "501";
const DM = "20";
const GUILD = "77";
const CHANNEL = "30";
const THREAD = "31";

async function connect(discord = new FakeDiscord(), opts: { token?: string; outbound?: Record<string, Uint8Array> } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  const ac = new AbortController();
  const session = await openDiscord("bot", {
    signal: ac.signal,
    credentials: { botToken: opts.token ?? discord.token },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array()
  }, { net: discord.net(), backoffMs: 10 });
  const handle = { discord, session, events, states, close: () => { ac.abort(); void session.close(); } };
  open.push(handle);
  return handle;
}

async function until(what: string, condition: () => boolean, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 5) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error(`timed out: ${what}`);
}

let ops = 0;
const delivery = (o: Partial<ImDelivery> & { channel: string; guild?: string }): ImDelivery => ({
  operationId: `op${++ops}`, address: { tenantId: o.guild ?? "@me", conversationId: o.channel }, content: { text: "hello" }, ...o
});
const of = <K extends ImInbound["kind"]>(events: ImInbound[], kind: K) => events.filter(e => e.kind === kind) as (ImInbound & { kind: K })[];
const posted = (discord: FakeDiscord, channel: string) => [...discord.messages.values()].filter(m => m.channel === channel).map(m => m.body);
const controls = (body: Record<string, unknown>) => (body.components as { components: { type: number; custom_id?: string; max_values?: number }[] }[]).flatMap(r => r.components);

describe("connecting", () => {
  it("signs in as the bot and registers /tomrade with a subcommand per IM command", async () => {
    const { discord, session, states } = await connect();
    expect(session.identity).toEqual({ id: "900", name: "tomrade-bot" });
    expect(states.at(-1)).toBe("connected");
    expect(resolveImCapabilities(CAPABILITIES)).toBeTruthy();
    await session.commands!([{ name: "status", description: "What is running" }, { name: "steer", description: "Steer", args: "text" }]);
    const [command] = discord.where("PUT", /^\/applications\/800\/commands$/)[0]!.body as unknown as { name: string; options: { name: string; options?: unknown[] }[] }[];
    expect(command!.name).toBe("tomrade");
    expect(command!.options.map(o => o.name)).toEqual(["status", "steer"]);
    expect(command!.options[1]!.options).toHaveLength(1);
  });

  it("refuses a wrong token instead of retrying it forever", async () => {
    await expect(connect(new FakeDiscord(), { token: "wrong" })).rejects.toThrow(/refused the bot token/);
  });

  it("resumes after a drop and replays what it missed, with the same event ids", async () => {
    const { discord, events } = await connect();
    discord.message({ channel: DM, author: OWNER, content: "one" });
    await until("the first message", () => of(events, "message").length === 1);
    discord.drop();
    const missed = discord.message({ channel: DM, author: OWNER, content: "while away" });
    await until("the missed message", () => of(events, "message").length === 2);
    expect(discord.sockets[1]!.url).toMatch(/^wss:\/\/resume\.discord\.gg\//);
    // Discord may redeliver an event; it keeps its id so the IM layer keeps it once.
    discord.dispatch("MESSAGE_CREATE", missed);
    await until("the redelivery", () => of(events, "message").length === 3);
    expect(of(events, "message")[2]!.eventId).toBe(of(events, "message")[1]!.eventId);
  });

  it("drops a connection whose heartbeats go unanswered and resumes", async () => {
    const { discord, events } = await connect();
    discord.silent = true;
    await until("a new socket", () => discord.sockets.length > 1);
    discord.silent = false;
    discord.message({ channel: DM, author: OWNER, content: "after" });
    await until("the message after", () => of(events, "message").some(e => e.text === "after"));
  });
});

describe("messages in", () => {
  it("hands over a direct message, a mention in a channel and a message in a thread", async () => {
    const { discord, events } = await connect();
    discord.dispatch("GUILD_CREATE", { id: GUILD, channels: [{ id: CHANNEL, type: 0 }], threads: [{ id: THREAD, type: 11, parent_id: CHANNEL }] });
    discord.message({ channel: DM, author: OWNER, content: "hello" });
    discord.message({ channel: CHANNEL, guild: GUILD, author: OWNER, content: "" });
    const asked = discord.message({ channel: CHANNEL, guild: GUILD, author: OWNER, content: "<@900> status of the launch", mentions: true });
    discord.message({ channel: THREAD, guild: GUILD, author: OWNER, content: "<@900> in the thread", mentions: true });
    await until("three messages", () => of(events, "message").length === 3);
    const [dm, mention, thread] = of(events, "message");
    expect(dm).toMatchObject({ text: "hello", activation: "dm", actor: { id: OWNER }, address: { tenantId: "@me", conversationId: DM } });
    expect(mention).toMatchObject({ text: "status of the launch", activation: "mention", messageId: asked.id, address: { tenantId: GUILD, conversationId: CHANNEL } });
    expect(thread).toMatchObject({ text: "in the thread", address: { tenantId: GUILD, conversationId: CHANNEL, topicId: THREAD } });
  });

  it("downloads attachments it is sent", async () => {
    const { discord, session, events } = await connect();
    discord.message({ channel: DM, author: OWNER, content: "look", attachments: [{ id: "a1", filename: "shot.png", content_type: "image/png", size: "bytes of shot.png".length }] });
    await until("the message", () => of(events, "message").length === 1);
    const [ref] = of(events, "message")[0]!.attachments!;
    expect(ref).toMatchObject({ id: "a1", name: "shot.png", mimeType: "image/png" });
    expect(new TextDecoder().decode(await session.download!(ref!))).toBe("bytes of shot.png");
  });

  it("tells the IM layer when its sender edits or deletes a message", async () => {
    const { discord, events } = await connect();
    const m = discord.message({ channel: DM, author: OWNER, content: "never mind" });
    await until("the message", () => of(events, "message").length === 1);
    discord.dispatch("MESSAGE_UPDATE", { id: m.id, channel_id: DM, edited_timestamp: "2026-10-19T00:00:00Z" });
    discord.dispatch("MESSAGE_DELETE", { id: m.id, channel_id: DM });
    await until("the edit and the deletion", () => of(events, "retract").length === 1 && of(events, "edit").length === 1);
    expect(of(events, "retract")[0]).toMatchObject({ messageId: m.id, actor: { id: OWNER } });
  });
});

describe("controls and commands", () => {
  async function card(h: Awaited<ReturnType<typeof connect>>, content: ImDelivery["content"]) {
    await h.session.deliver(delivery({ channel: DM, content }));
    return controls(posted(h.discord, DM).at(-1)!);
  }
  async function press(discord: FakeDiscord, o: { custom_id: string; component_type?: number; values?: string[]; type?: number; components?: unknown[] }) {
    const i = discord.interaction({ type: o.type ?? 3, channel: DM, user: OWNER, data: { custom_id: o.custom_id, component_type: o.component_type ?? 2, ...(o.values ? { values: o.values } : {}), ...(o.components ? { components: o.components } : {}) } });
    const sent = Date.now();
    await until("the callback", () => discord.where("POST", new RegExp(`^/interactions/${i.id}/`)).length === 1);
    const callback = discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]!;
    expect(callback.at - sent).toBeLessThan(3000);
    return callback.body;
  }

  it("answers buttons, selects and a form, acknowledged within three seconds", async () => {
    const h = await connect();
    const [yes] = await card(h, { text: "Ship it?", actions: [{ label: "Yes", token: "t-yes" }, { label: "No", token: "t-no" }] });
    expect(await press(h.discord, { custom_id: yes!.custom_id! })).toEqual({ type: 6 });
    await until("the button", () => of(h.events, "action").length === 1);
    expect(of(h.events, "action")[0]).toMatchObject({ token: "t-yes", actor: { id: OWNER } });

    const [select] = await card(h, { text: "Which targets?", elements: [{ type: "select", token: "t-targets", multiple: true, options: [{ label: "web", value: "web" }, { label: "cli", value: "cli" }] }] });
    expect(select!.max_values).toBe(2);
    await press(h.discord, { custom_id: select!.custom_id!, component_type: 3, values: ["web", "cli"] });
    await until("the select", () => of(h.events, "action").length === 2);
    expect(of(h.events, "action")[1]).toMatchObject({ token: "t-targets", value: ["web", "cli"] });

    const [form] = await card(h, { text: "Why?", elements: [{ type: "input", token: "t-why", label: "Answer" }] });
    expect(await press(h.discord, { custom_id: form!.custom_id! })).toMatchObject({ type: 9, data: { custom_id: form!.custom_id } });
    await press(h.discord, { type: 5, custom_id: form!.custom_id!, components: [{ type: 1, components: [{ type: 4, custom_id: "answer", value: "it is late" }] }] });
    await until("the form", () => of(h.events, "action").length === 3);
    expect(of(h.events, "action")[2]).toMatchObject({ token: "t-why", value: "it is late" });
  });

  it("takes /tomrade commands, deferring within three seconds", async () => {
    const { discord, events } = await connect();
    const i = discord.interaction({ type: 2, channel: DM, user: OWNER, data: { name: "tomrade", options: [{ type: 1, name: "steer", options: [{ type: 3, name: "args", value: "say hi" }] }] } });
    const sent = Date.now();
    await until("the deferral", () => discord.where("POST", new RegExp(`^/interactions/${i.id}/`)).length === 1);
    expect(discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]).toMatchObject({ body: { type: 5 } });
    expect(discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]!.at - sent).toBeLessThan(3000);
    await until("the command", () => of(events, "message").length === 1);
    expect(discord.where("PATCH", /@original$/)[0]?.body?.content).toBe("› /steer say hi");
    expect(of(events, "message")[0]).toMatchObject({ text: "/steer say hi", activation: "dm" });
  });
});

describe("messages out", () => {
  it("quotes the message it answers, posts once per operation, and edits in place", async () => {
    const { discord, session } = await connect();
    const d = delivery({ channel: DM, replyTo: "4242", content: { text: "echo" } });
    const first = await session.deliver(d);
    // A retry after a lost answer carries the same nonce, which Discord enforces.
    expect(await session.deliver(d)).toEqual(first);
    expect(posted(discord, DM)).toHaveLength(1);
    expect(posted(discord, DM)[0]).toMatchObject({ content: "echo", enforce_nonce: true, message_reference: { message_id: "4242", fail_if_not_exists: false } });
    await session.deliver(delivery({ channel: DM, replaceMessageId: first.messageId, content: { text: "echo, edited" } }));
    expect(discord.messages.get(first.messageId)?.body).toMatchObject({ content: "echo, edited", components: [] });
  });

  it("posts into a thread and uploads files", async () => {
    const { discord, session } = await connect();
    await session.deliver({ ...delivery({ channel: CHANNEL, guild: GUILD, content: { text: "here", files: [{ id: "f1", name: "a.txt", mimeType: "text/plain", size: 2 }] } }), threadId: THREAD });
    expect(discord.where("POST", new RegExp(`^/channels/${THREAD}/messages$`))[0]!.files).toEqual(["a.txt"]);
  });

  it("reports a rate limit as retryable after Discord's wait", async () => {
    const { discord, session } = await connect();
    discord.failNext(c => c.method === "POST" && c.path === `/channels/${DM}/messages`, 429, { retryAfter: 0.1 });
    const refused = await session.deliver(delivery({ channel: DM })).catch(e => e);
    expect(refused).toBeInstanceOf(ImDeliveryError);
    expect(refused).toMatchObject({ disposition: "retryable", retryAfterMs: 100 });
    await session.deliver(delivery({ channel: DM }));
    expect(posted(discord, DM)).toHaveLength(1);
  });

  it("swaps 👀 for the outcome and types while working", async () => {
    const { discord, session } = await connect();
    const address = { tenantId: "@me", conversationId: DM };
    await session.react!({ address, messageId: "55", reaction: "received" });
    await session.react!({ address, messageId: "55", reaction: "done" });
    expect(discord.where("PUT", /reactions/).map(c => decodeURIComponent(c.path.split("/")[6]!))).toEqual(["👀", "✅"]);
    expect(discord.where("DELETE", /\/messages\/55\/reactions\//)).toHaveLength(1);
    await session.indicate!({ address, state: "typing" });
    expect(discord.where("POST", /\/typing$/)).toHaveLength(1);
  });
});
