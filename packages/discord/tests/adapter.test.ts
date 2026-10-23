import { afterEach, describe, expect, it } from "vitest";
import { ImDeliveryError, resolveImCapabilities, type ImAdapter, type ImDelivery, type ImInbound, type ImNotice } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openDiscord } from "../src/adapter.js";
import { FakeDiscord } from "../src/fake.js";
import plugin from "../src/index.js";
import { installLink } from "../src/wire.js";

const open: { close(): void }[] = [];
afterEach(() => { for (const o of open.splice(0)) o.close(); });

const OWNER = "501";
const DM = "20";
const GUILD = "77";
const CHANNEL = "30";
const THREAD = "31";

type Host = Pick<Parameters<typeof openDiscord>[1], "projects" | "allow">;
async function connect(discord = new FakeDiscord(), opts: { token?: string; outbound?: Record<string, Uint8Array>; olderHost?: boolean; host?: Host } = {}) {
  const events: ImInbound[] = [];
  const states: string[] = [];
  /** What the adapter told the host: notices, and `clear:<key>` once their cause went. */
  const notices: (ImNotice | string)[] = [];
  const ac = new AbortController();
  const session = await openDiscord("bot", {
    signal: ac.signal,
    credentials: { botToken: opts.token ?? discord.token },
    receive: async e => { events.push(e); return { receiptId: `r${events.length}` }; },
    status: s => { states.push(s); },
    readOutboundFile: async id => opts.outbound?.[id] ?? new Uint8Array(),
    ...(opts.olderHost ? {} : { notice: (n: ImNotice) => { notices.push(n); }, clearNotice: (key: string) => { notices.push(`clear:${key}`); } }),
    ...opts.host
  }, { net: discord.net(), backoffMs: 10 });
  const handle = { discord, session, events, states, notices, close: () => { ac.abort(); void session.close(); } };
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

describe("ticket threads", () => {
  const TITLE = "TOM-42 · Doing · Fix the login page";
  const room = { tenantId: GUILD, conversationId: CHANNEL };

  it("opens a public thread in a text channel, and messages in it arrive as its topic", async () => {
    const { discord, session, events } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "t1", address: room, title: TITLE });
    expect(discord.threads.get(topicId)).toEqual({ parent: CHANNEL, body: { name: TITLE, type: 11, auto_archive_duration: 10080 } });
    discord.message({ channel: topicId, guild: GUILD, author: OWNER, content: "<@900> what is left?", mentions: true });
    await until("the thread's message", () => of(events, "message").length === 1);
    expect(of(events, "message")[0]).toMatchObject({ text: "what is left?", address: { ...room, topicId } });
  });

  it("opens a post in a forum or media channel and an announcement thread in an announcement channel", async () => {
    const discord = new FakeDiscord();
    discord.channelTypes.set("40", 15).set("41", 16).set("42", 5);
    const { session } = await connect(discord);
    for (const channel of ["40", "41"]) {
      const { topicId } = await session.topics!.open({ operationId: `t${channel}`, address: { tenantId: GUILD, conversationId: channel }, title: TITLE });
      expect(discord.threads.get(topicId)!.body).toEqual({ name: TITLE, auto_archive_duration: 10080, message: { content: TITLE, allowed_mentions: { parse: [] } } });
    }
    const { topicId } = await session.topics!.open({ operationId: "t42", address: { tenantId: GUILD, conversationId: "42" }, title: TITLE });
    expect(discord.threads.get(topicId)!.body).toMatchObject({ type: 10 });
  });

  it("clips a long title to Discord's hundred characters", async () => {
    const { discord, session } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "t1", address: room, title: `TOM-42 · Doing · ${"x".repeat(200)}` });
    const name = discord.threads.get(topicId)!.body.name as string;
    expect([...name]).toHaveLength(100);
    expect(name.endsWith("…")).toBe(true);
  });

  it("renames the thread as its ticket moves, archives it once done, and opens it again", async () => {
    const { discord, session } = await connect();
    const { topicId } = await session.topics!.open({ operationId: "t1", address: room, title: TITLE });
    const address = { ...room, topicId };
    await session.topics!.update({ address, title: "TOM-42 · Verifying · Fix the login page", closed: false });
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: true });
    // The same name again is not a rename: Discord allows only a few.
    await session.topics!.update({ address, title: "TOM-42 · Done · Fix the login page", closed: false });
    expect(discord.where("PATCH", new RegExp(`^/channels/${topicId}$`)).map(c => c.body)).toEqual([
      { name: "TOM-42 · Verifying · Fix the login page", archived: false },
      { name: "TOM-42 · Done · Fix the login page", archived: true },
      { archived: false }
    ]);
  });

  it("reports Discord's refusals and rate limits as messages do, and opens no thread in a direct chat", async () => {
    const { discord, session } = await connect();
    discord.failNext(c => c.path.endsWith("/threads"), 403);
    await expect(session.topics!.open({ operationId: "t1", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    discord.failNext(c => c.path.endsWith("/threads"), 429, { retryAfter: 2 });
    await expect(session.topics!.open({ operationId: "t2", address: room, title: TITLE })).rejects.toMatchObject({ disposition: "retryable", retryAfterMs: 2000 });
    await expect(session.topics!.open({ operationId: "t3", address: { tenantId: "@me", conversationId: DM }, title: TITLE })).rejects.toBeInstanceOf(ImDeliveryError);
  });
});

describe("adding the bot and its permissions", () => {
  /** Discord's documented bits for each permission the setup lists. */
  const BITS: Record<string, bigint> = {
    "View Channels": 1n << 10n, "Send Messages": 1n << 11n, "Send Messages in Threads": 1n << 38n, "Create Public Threads": 1n << 35n,
    "Manage Threads": 1n << 34n, "Read Message History": 1n << 16n, "Embed Links": 1n << 14n, "Attach Files": 1n << 15n, "Add Reactions": 1n << 6n,
    "Manage Channels": 1n << 4n
  };
  const room = { tenantId: GUILD, conversationId: CHANNEL };
  const TITLE = "TOM-42 · Doing · Fix the login page";

  it("offers an install link, once connected, asking for exactly the permissions setup lists", async () => {
    let adapter: ImAdapter | undefined;
    await plugin.apply({ im: { register: async (a: ImAdapter) => { adapter = a; return () => {}; } } } as never, undefined as never);
    const listed = adapter!.setup!.permissions!.map(p => p.replace(/ \(optional: .*\)$/, ""));
    expect(adapter!.setup!.permissions).toContain("Manage Channels (optional: /tomrade setup)");
    expect(listed.every(name => BITS[name] !== undefined)).toBe(true);
    const bits = listed.reduce((sum, name) => sum | BITS[name]!, 0n);
    const { session } = await connect();
    const url = new URL(session.links![0]!.url);
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "800", scope: "bot applications.commands", permissions: String(bits) });
    expect(session.links![0]!.label).toEqual({ en: "Add the bot to a server", zh: "把机器人加到服务器" });
    expect(session.links![0]!.url).toBe(installLink("800"));
  });

  it("says a missing permission once per channel, and again only after it worked in between", async () => {
    const { discord, session, notices } = await connect();
    discord.failNext(c => c.path.endsWith("/threads"), 403, { code: 50013, times: 2 });
    for (const op of ["t1", "t2"]) await expect(session.topics!.open({ operationId: op, address: room, title: TITLE })).rejects.toMatchObject({ disposition: "permanent" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ key: `perm:${CHANNEL}:Create Public Threads`, address: room, link: { url: installLink("800") },
      text: { en: expect.stringContaining("missing the **Create Public Threads** permission") } });

    // Granted: the next one opens without a restart, and the notice is withdrawn.
    const { topicId } = await session.topics!.open({ operationId: "t3", address: room, title: TITLE });
    expect(discord.threads.has(topicId)).toBe(true);
    expect(notices.at(-1)).toBe(`clear:perm:${CHANNEL}:Create Public Threads`);
    discord.failNext(c => c.path.endsWith("/threads"), 403, { code: 50013 });
    await expect(session.topics!.open({ operationId: "t4", address: room, title: TITLE })).rejects.toBeInstanceOf(ImDeliveryError);
    expect(notices.filter(n => typeof n !== "string")).toHaveLength(2);
  });

  it("names the permission each refused call needs, and says nothing for a direct chat or another refusal", async () => {
    const { discord, session, notices } = await connect();
    const keys = () => notices.flatMap(n => typeof n === "string" ? [] : [n.key]);
    discord.failNext(c => c.method === "POST" && c.path === `/channels/${THREAD}/messages`, 403, { code: 50013 });
    await expect(session.deliver(delivery({ guild: GUILD, channel: CHANNEL, address: { ...room, topicId: THREAD } }))).rejects.toBeInstanceOf(ImDeliveryError);
    discord.failNext(c => c.method === "PATCH" && c.path === `/channels/${THREAD}`, 403, { code: 50013 });
    await expect(session.topics!.update({ address: { ...room, topicId: THREAD }, title: TITLE, closed: true })).rejects.toBeInstanceOf(ImDeliveryError);
    discord.failNext(c => c.path.includes("/reactions/"), 403, { code: 50013 });
    await expect(session.react!({ address: room, messageId: "5", reaction: "received" })).rejects.toBeInstanceOf(ImDeliveryError);
    discord.failNext(c => c.method === "POST" && c.path === "/channels/32/messages", 403, { code: 50001 });
    await expect(session.deliver(delivery({ guild: GUILD, channel: "32" }))).rejects.toBeInstanceOf(ImDeliveryError);
    discord.failNext(c => c.method === "POST" && c.path === `/channels/${DM}/messages`, 403, { code: 50013 });
    await expect(session.deliver(delivery({ channel: DM }))).rejects.toBeInstanceOf(ImDeliveryError);
    discord.failNext(c => c.method === "POST" && c.path === `/channels/${CHANNEL}/messages`, 403);
    await expect(session.deliver(delivery({ guild: GUILD, channel: CHANNEL }))).rejects.toBeInstanceOf(ImDeliveryError);
    expect(keys()).toEqual([`perm:${CHANNEL}:Send Messages in Threads`, `perm:${CHANNEL}:Manage Threads`, `perm:${CHANNEL}:Add Reactions`, "perm:32:Send Messages"]);
    expect((notices.at(-1) as ImNotice).text).toMatchObject({ en: expect.stringContaining("missing the **View Channels** permission") });
  });

  it("on a Tomrade without notices, says it in the channel itself", async () => {
    const { discord, session } = await connect(new FakeDiscord(), { olderHost: true });
    discord.failNext(c => c.path.endsWith("/threads"), 403, { code: 50013, times: 2 });
    for (const op of ["t1", "t2"]) await expect(session.topics!.open({ operationId: op, address: room, title: TITLE })).rejects.toBeInstanceOf(ImDeliveryError);
    await until("the line in the channel", () => posted(discord, CHANNEL).length === 1);
    await new Promise(r => setTimeout(r, 20));
    expect(posted(discord, CHANNEL)).toEqual([{ content: expect.stringMatching(/missing the \*\*Create Public Threads\*\* permission[\s\S]*Add the bot to a server: https:\/\/discord\.com\/oauth2\/authorize/), allowed_mentions: { parse: [] } }]);
  });
});

describe("/tomrade setup", () => {
  const LOGIN = { id: "p1", name: "Login" };
  const SHOP = { id: "p2", name: "Web Shop" };
  /** Tomrade as the adapter sees it: the owner is paired, and each allowed conversation is remembered. */
  const host = (projects = [LOGIN]) => {
    const allowed: { conversationId: string; kind: string; projectId: string }[] = [];
    const io: Host = {
      projects: actorId => actorId === OWNER ? projects : [],
      allow: r => { if (r.actorId !== OWNER) return false; allowed.push({ conversationId: r.address.conversationId, kind: r.kind, projectId: r.projectId }); return true; }
    };
    return { io, allowed };
  };
  const setup = (discord: FakeDiscord, o: { user?: string; project?: string; locale?: string; appPermissions?: bigint } = {}) => discord.interaction({ type: 2, channel: CHANNEL, guild: GUILD, user: o.user ?? OWNER,
    data: { name: "tomrade", options: [{ type: 1, name: "setup", options: o.project ? [{ type: 3, name: "project", value: o.project }] : [] }] },
    ...(o.locale ? { locale: o.locale } : {}), ...(o.appPermissions !== undefined ? { appPermissions: o.appPermissions } : {}) });
  const reply = async (discord: FakeDiscord, n: number) => {
    await until("the reply", () => discord.where("PATCH", /^\/webhooks\/800\/itoken-\d+\/messages\/@original$/).length === n);
    return discord.where("PATCH", /@original$/).at(-1)!.body!.content as string;
  };
  const made = (discord: FakeDiscord) => discord.where("POST", new RegExp(`^/guilds/${GUILD}/channels$`)).map(c => c.body);

  it("is registered only where Tomrade can allow the channels it makes", async () => {
    for (const [io, has] of [[host().io, true], [undefined, false]] as const) {
      const { discord, session } = await connect(new FakeDiscord(), io ? { host: io } : {});
      await session.commands!([{ name: "status", description: "What is running" }]);
      const [command] = discord.where("PUT", /\/commands$/)[0]!.body as unknown as { options: { name: string; options?: { name: string; autocomplete?: boolean }[] }[] }[];
      expect(command!.options.map(o => o.name)).toEqual(has ? ["status", "setup"] : ["status"]);
      if (has) expect(command!.options[1]!.options).toMatchObject([{ name: "project", autocomplete: true }]);
    }
  });

  it("creates a Tomrade category with the work, status and chat channels, allows each, and says what they are for", async () => {
    const { io, allowed } = host();
    const { discord } = await connect(new FakeDiscord(), { host: io });
    const i = setup(discord, { appPermissions: 1n << 4n });
    const said = await reply(discord, 1);
    expect(discord.where("POST", new RegExp(`^/interactions/${i.id}/`))[0]!.body).toEqual({ type: 5, data: { flags: 64 } });
    const [category, ...channels] = made(discord);
    expect(category).toEqual({ name: "Tomrade", type: 4 });
    expect(channels.map(c => c!.name)).toEqual(["tomrade-work", "tomrade-status", "tomrade-chat"]);
    expect(channels.map(c => c!.topic)).toEqual([
      "Tomrade: a thread for each ticket of Login being worked · tomrade:p1:work",
      "Tomrade: news of Login's tickets and code · tomrade:p1:status",
      "Tomrade: talk to Login's assistant by @mentioning the bot · tomrade:p1:chat"]);
    const ids = discord.guildChannels.get(GUILD)!.filter(c => c.type === 0).map(c => c.id);
    expect(channels.every(c => c!.parent_id === discord.guildChannels.get(GUILD)![0]!.id)).toBe(true);
    expect(allowed).toEqual([{ conversationId: ids[0], kind: "work", projectId: "p1" }, { conversationId: ids[1], kind: "status", projectId: "p1" }, { conversationId: ids[2], kind: "chat", projectId: "p1" }]);
    expect(said).toBe([`Tomrade is set up for **Login**:`, `<#${ids[0]}> — a thread for each ticket being worked`,
      `<#${ids[1]}> — ticket and code news, routines, and when Tomrade comes online or goes offline`, `<#${ids[2]}> — @mention me to talk to the assistant`,
      "Run /tomrade setup again any time to put back what is missing; change what each channel hears in Tomrade's IM settings."].join("\n"));
  });

  it("names the channels in the person's language", async () => {
    const { discord } = await connect(new FakeDiscord(), { host: host().io });
    setup(discord, { locale: "zh-CN" });
    expect(await reply(discord, 1)).toMatch(/^Tomrade 已为 \*\*Login\*\* 设置好：/);
    expect(made(discord).slice(1).map(c => c!.name)).toEqual(["tomrade-工作", "tomrade-状态", "tomrade-聊天"]);
  });

  it("run again, creates nothing; a deleted channel comes back and is allowed again; a channel of that name is reused", async () => {
    const discord = new FakeDiscord();
    discord.guildChannels.set(GUILD, [{ id: "60", type: 0, name: "tomrade-chat", parent_id: null, topic: null }]);
    const { io, allowed } = host();
    await connect(discord, { host: io });
    setup(discord);
    await reply(discord, 1);
    expect(made(discord).map(c => c!.name)).toEqual(["Tomrade", "tomrade-work", "tomrade-status"]);
    expect(allowed.map(a => a.conversationId).at(-1)).toBe("60");

    setup(discord);
    await reply(discord, 2);
    expect(made(discord)).toHaveLength(3);
    expect(allowed).toHaveLength(6);

    const status = discord.guildChannels.get(GUILD)!.find(c => c.name === "tomrade-status")!;
    discord.guildChannels.set(GUILD, discord.guildChannels.get(GUILD)!.filter(c => c !== status));
    setup(discord);
    await reply(discord, 3);
    expect(made(discord).map(c => c!.name)).toEqual(["Tomrade", "tomrade-work", "tomrade-status", "tomrade-status"]);
    const again = discord.guildChannels.get(GUILD)!.find(c => c.name === "tomrade-status")!;
    expect(again.parent_id).toBe(discord.guildChannels.get(GUILD)!.find(c => c.type === 4)!.id);
    expect(allowed.at(-2)).toEqual({ conversationId: again.id, kind: "status", projectId: "p1" });
  });

  it("explains, with the install link, when it may not create channels", async () => {
    const { discord } = await connect(new FakeDiscord(), { host: host().io });
    setup(discord, { appPermissions: (1n << 10n) | (1n << 11n) });
    expect(await reply(discord, 1)).toBe(`I can't create channels here: the bot is missing the **Manage Channels** permission. Add the bot again with this link, keeping Manage Channels ticked, then run /tomrade setup again:\n${installLink("800")}`);
    expect(made(discord)).toEqual([]);
    discord.failNext(c => c.method === "POST" && c.path === `/guilds/${GUILD}/channels`, 403, { code: 50013 });
    setup(discord);
    expect(await reply(discord, 2)).toMatch(/missing the \*\*Manage Channels\*\* permission/);
  });

  it("politely refuses someone not paired, and says what to do on an older Tomrade", async () => {
    const { io, allowed } = host();
    const { discord } = await connect(new FakeDiscord(), { host: io });
    setup(discord, { user: "502" });
    expect(await reply(discord, 1)).toBe("Only the person paired with Tomrade can set up its channels. Pair first: send me a direct message with the code from Tomrade's IM settings.");
    expect(made(discord)).toEqual([]);
    expect(allowed).toEqual([]);
    const older = await connect(new FakeDiscord());
    setup(older.discord);
    expect(await reply(older.discord, 1)).toMatch(/^This needs a newer Tomrade/);
  });

  it("with several projects, completes the project option and names channels after the project when another is set up here", async () => {
    const { io, allowed } = host([LOGIN, SHOP]);
    const { discord } = await connect(new FakeDiscord(), { host: io });
    const ask = discord.interaction({ type: 4, channel: CHANNEL, guild: GUILD, user: OWNER,
      data: { name: "tomrade", options: [{ type: 1, name: "setup", options: [{ type: 3, name: "project", value: "sho", focused: true }] }] } });
    await until("the choices", () => discord.where("POST", new RegExp(`^/interactions/${ask.id}/`)).length === 1);
    expect(discord.where("POST", new RegExp(`^/interactions/${ask.id}/`))[0]!.body).toEqual({ type: 8, data: { choices: [{ name: "Web Shop", value: "p2" }] } });

    setup(discord);
    await reply(discord, 1);
    setup(discord, { project: "p2" });
    expect(await reply(discord, 2)).toMatch(/^Tomrade is set up for \*\*Web Shop\*\*/);
    expect(made(discord).map(c => c!.name)).toEqual(["Tomrade", "tomrade-work", "tomrade-status", "tomrade-chat", "tomrade-work-web-shop", "tomrade-status-web-shop", "tomrade-chat-web-shop"]);
    expect(allowed.slice(3).map(a => a.projectId)).toEqual(["p2", "p2", "p2"]);
  });
});

describe("naming conversations", () => {
  it("names a server channel as #name, from what the gateway said or by asking, and a direct chat by the person in it", async () => {
    const discord = new FakeDiscord();
    discord.guildChannels.set(GUILD, [{ id: "61", type: 0, name: "asked-for" }]);
    discord.dms.set(DM, { id: OWNER, name: "Tom" });
    const { session } = await connect(discord);
    discord.dispatch("GUILD_CREATE", { id: GUILD, channels: [{ id: CHANNEL, type: 0, name: "tomrade-work" }] });
    await new Promise(r => setTimeout(r, 20));
    expect(await session.describe!({ tenantId: GUILD, conversationId: CHANNEL })).toEqual({ name: "#tomrade-work" });
    expect(discord.where("GET", new RegExp(`^/channels/${CHANNEL}$`))).toEqual([]);
    expect(await session.describe!({ tenantId: GUILD, conversationId: "61" })).toEqual({ name: "#asked-for" });
    expect(await session.describe!({ tenantId: "@me", conversationId: DM })).toEqual({ name: "Tom" });
    expect(await session.describe!({ tenantId: GUILD, conversationId: "404" })).toBeNull();
  });

  it("names the channels /tomrade setup allows", async () => {
    const named: string[] = [];
    const discord = new FakeDiscord();
    await connect(discord, { host: { projects: () => [{ id: "p1", name: "Login" }], allow: r => { named.push(r.name ?? ""); return true; } } });
    discord.interaction({ type: 2, channel: CHANNEL, guild: GUILD, user: OWNER, data: { name: "tomrade", options: [{ type: 1, name: "setup", options: [] }] } });
    await until("the channels are allowed", () => named.length === 3);
    expect(named).toEqual(["#tomrade-work", "#tomrade-status", "#tomrade-chat"]);
  });
});

