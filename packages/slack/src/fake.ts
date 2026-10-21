import type { Net } from "./api.js";

/** A Web API call the fake received. */
export interface FakeCall { method: string; args: Record<string, string>; token: string; at: number }
/** A message on the fake's side: what a person sent, or what the bot posted. */
export interface FakeMessage {
  channel: string; ts: string; thread?: string; user?: string; botId?: string; text: string;
  blocks?: Record<string, unknown>[]; markdown?: string; streaming?: boolean; files?: string[];
  metadata?: { event_type: string; event_payload: Record<string, unknown> };
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/**
 * Slack in memory: apps.connections.open and a Socket Mode socket (hello,
 * disconnect, envelopes and their acknowledgements), the Web API methods the
 * adapter calls, and files.slack.com for uploads and downloads. For tests and
 * the plugin's own scenario; never shipped as the adapter.
 */
export class FakeSlack {
  readonly appToken = "xapp-1-A0FAKE-1-fake";
  readonly botToken = "xoxb-1-fake";
  readonly team = "T0FAKE";
  readonly appId = "A0FAKE";
  readonly bot = { userId: "U0BOT", botId: "B0BOT", name: "tomrade", displayName: "Tomrade" };
  readonly calls: FakeCall[] = [];
  readonly sockets: FakeSocket[] = [];
  readonly messages: FakeMessage[] = [];
  readonly reactions: { channel: string; ts: string; name: string; removed: boolean }[] = [];
  readonly statuses: { channel: string; thread: string; status: string }[] = [];
  /** What the adapter acknowledged, by envelope id. */
  readonly acks = new Map<string, { payload?: unknown; at: number }>();
  /** When each envelope was sent, so a test can tell how fast it was acknowledged. */
  readonly sentAt = new Map<string, number>();
  readonly users = new Map<string, string>([["U0BOT", "Tomrade"]]);
  /** Channel names `conversations.info` gives; a direct message names the person in it by `dms`. */
  readonly channels = new Map<string, string>();
  readonly dms = new Map<string, string>();
  /** `conversations.info` answers missing_scope, as for an app without channels:read. */
  noChannelScope = false;
  readonly files = new Map<string, { name: string; mimetype: string; bytes: Uint8Array; shared?: boolean }>();
  /** When set, chat.startStream is refused, as where Slack streams nothing. */
  noStream = false;
  /** When set, the app has no channels:history or groups:history. */
  noHistory = false;
  private ids = 0;
  private clock = 1_700_000_000;
  private fail: { match: (c: FakeCall) => boolean; status: number; error: string; retryAfter?: number; needed?: string; times: number }[] = [];

  get live() { const s = this.sockets.filter(s => s.readyState === 1).at(-1); return s ?? null; }
  /** Failures set with failNext that have not happened yet. */
  get failing() { return this.fail.reduce((n, f) => n + f.times, 0); }

  net(): Net {
    const fake = this;
    class Socket extends FakeSocket { constructor(url: string) { super(fake, url); } }
    return { fetch: (input, init) => this.fetch(String(input), init), WebSocket: Socket as unknown as typeof WebSocket };
  }

  id(prefix: string) { return `${prefix}${++this.ids}`; }
  ts() { return `${this.clock}.${String(++this.ids).padStart(6, "0")}`; }

  /** Answers the next calls `match` picks with `status` and Slack's `error` (a 429 carries Retry-After, in seconds). */
  failNext(match: (c: FakeCall) => boolean, status: number, error: string, opts: { retryAfter?: number; times?: number; needed?: string } = {}) {
    this.fail.push({ match, status, error, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), ...(opts.needed ? { needed: opts.needed } : {}), times: opts.times ?? 1 });
  }

  /** The connection breaks without a word. */
  drop() { this.live?.serverClose(1006); }

  /** Slack asks the client to move to a fresh connection; this one closes once the client lets it go. */
  disconnect(reason = "refresh_requested") { this.live?.push({ type: "disconnect", reason, debug_info: { host: "applink-1" } }); }

  /** Sends an envelope to the live connection; returns its id. */
  envelope(type: string, payload: unknown, opts: { retry?: number; envelopeId?: string } = {}) {
    const envelopeId = opts.envelopeId ?? this.id("env-");
    this.sentAt.set(envelopeId, Date.now());
    this.live?.push({ envelope_id: envelopeId, type, payload, accepts_response_payload: type !== "events_api",
      ...(type === "events_api" ? { retry_attempt: opts.retry ?? 0, retry_reason: opts.retry ? "timeout" : "" } : {}) });
    return envelopeId;
  }

  /** An Events API event; `eventId` and `retry` redeliver one. */
  event(event: Record<string, unknown>, opts: { eventId?: string; retry?: number } = {}) {
    const eventId = opts.eventId ?? this.id("Ev");
    const envelopeId = this.envelope("events_api", { token: "x", team_id: this.team, api_app_id: this.appId, event, type: "event_callback", event_id: eventId, event_time: this.clock }, opts);
    return { eventId, envelopeId };
  }

  /**
   * A person sends a message. In a channel a mention arrives as app_mention
   * and, with the history scopes, also as a message event; `thread` writes it
   * in a thread.
   */
  message(o: { channel: string; user: string; text?: string; thread?: string; mention?: boolean; files?: { id: string; name: string; mimetype: string; bytes: Uint8Array }[]; eventId?: string }) {
    const ts = this.ts();
    const text = `${o.mention ? `<@${this.bot.userId}> ` : ""}${o.text ?? ""}`;
    const files = (o.files ?? []).map(f => {
      this.files.set(f.id, { name: f.name, mimetype: f.mimetype, bytes: f.bytes });
      return { id: f.id, name: f.name, title: f.name, mimetype: f.mimetype, size: f.bytes.byteLength, mode: "hosted",
        url_private: `https://files.slack.com/files-pri/${this.team}-${f.id}/${f.name}`, url_private_download: `https://files.slack.com/files-pri/${this.team}-${f.id}/download/${f.name}` };
    });
    this.messages.push({ channel: o.channel, ts, ...(o.thread ? { thread: o.thread } : {}), user: o.user, text, ...(files.length ? { files: files.map(f => f.id) } : {}) });
    const direct = o.channel.startsWith("D");
    const event = { type: "message", ...(files.length ? { subtype: "file_share" } : {}), channel: o.channel, channel_type: direct ? "im" : "channel", user: o.user, text, ts, event_ts: ts,
      ...(o.thread ? { thread_ts: o.thread } : {}), ...(files.length ? { files } : {}) };
    if (direct || !o.mention) {
      const sent = this.event(event, o.eventId ? { eventId: o.eventId } : {});
      return { ts, event, ...sent };
    }
    const sent = this.event({ ...event, type: "app_mention", channel_type: undefined }, o.eventId ? { eventId: o.eventId } : {});
    this.event(event);
    return { ts, event, ...sent };
  }

  /** A person presses a control in one of the bot's messages; `state` is what its input blocks hold. */
  press(o: { channel: string; ts: string; user: string; action: Record<string, unknown>; state?: Record<string, unknown> }) {
    const m = this.find(o.channel, o.ts);
    return this.envelope("interactive", {
      type: "block_actions", trigger_id: this.id("trig."), user: { id: o.user, username: o.user, team_id: this.team }, team: { id: this.team },
      api_app_id: this.appId, container: { type: "message", message_ts: o.ts, channel_id: o.channel, is_ephemeral: false, ...(m?.thread ? { thread_ts: m.thread } : {}) },
      channel: { id: o.channel }, message: { type: "message", ts: o.ts, ...(m?.thread ? { thread_ts: m.thread } : {}), bot_id: this.bot.botId, text: m?.text ?? "" },
      state: { values: o.state ?? {} }, response_url: "https://hooks.slack.com/actions/x", actions: [{ ...o.action, action_ts: String(this.clock) }]
    });
  }

  /** A person runs `/tomrade <text>`. */
  command(o: { channel: string; user: string; text: string }) {
    return this.envelope("slash_commands", { token: "x", team_id: this.team, channel_id: o.channel, channel_name: o.channel.startsWith("D") ? "directmessage" : "general",
      user_id: o.user, user_name: o.user, command: "/tomrade", text: o.text, api_app_id: this.appId, response_url: "https://hooks.slack.com/commands/x", trigger_id: this.id("trig.") });
  }

  find(channel: string, ts: string) { return this.messages.find(m => m.channel === channel && m.ts === ts); }

  /** The bot's messages in a channel and its threads, oldest first. */
  posted(channel: string) { return this.messages.filter(m => m.channel === channel && m.botId === this.bot.botId); }

  /** What a message shows: its sections' mrkdwn, or what streamed into it. */
  textOf(m: FakeMessage): string {
    const sections = (m.blocks ?? []).filter(b => b.type === "section").map(b => (b.text as { text?: string } | undefined)?.text ?? "");
    return sections.length ? sections.join("\n") : m.markdown ?? m.text;
  }

  where(method: string) { return this.calls.filter(c => c.method === method); }

  // ── Socket Mode ──────────────────────────────────────────────────────

  open(socket: FakeSocket) {
    this.sockets.push(socket);
    queueMicrotask(() => {
      socket.emit("open", {});
      socket.push({ type: "hello", num_connections: this.sockets.filter(s => s.readyState === 1).length, connection_info: { app_id: this.appId },
        debug_info: { host: "applink-1", build_number: 1, approximate_connection_time: 18060 } });
    });
  }

  receive(data: string) {
    const ack = JSON.parse(data) as { envelope_id?: string; payload?: unknown };
    if (ack.envelope_id) this.acks.set(ack.envelope_id, { ...(ack.payload !== undefined ? { payload: ack.payload } : {}), at: Date.now() });
  }

  // ── Web API ──────────────────────────────────────────────────────────

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (u.host === "files.slack.com") return this.filesHost(u, init, token);
    const method = u.pathname.replace(/^\/api\//, "");
    const args = Object.fromEntries(new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body ?? "")));
    const call: FakeCall = { method, args, token, at: Date.now() };
    this.calls.push(call);
    const failing = this.fail.find(f => f.times > 0 && f.match(call));
    if (failing) {
      failing.times--;
      return json({ ok: false, error: failing.error, ...(failing.needed ? { needed: failing.needed } : {}) }, failing.status, failing.retryAfter !== undefined ? { "retry-after": String(failing.retryAfter) } : {});
    }
    if (method === "apps.connections.open") {
      if (token !== this.appToken) return json({ ok: false, error: token === this.botToken ? "not_allowed_token_type" : "invalid_auth" });
      return json({ ok: true, url: `wss://wss-primary.slack.com/link/?ticket=t${this.sockets.length}&app_id=${this.appId}` });
    }
    if (token !== this.botToken) return json({ ok: false, error: token === this.appToken ? "not_allowed_token_type" : "invalid_auth" });
    switch (method) {
      case "auth.test":
        return json({ ok: true, url: "https://fake.slack.com/", team: "Fake", user: this.bot.name, team_id: this.team, user_id: this.bot.userId, bot_id: this.bot.botId, is_enterprise_install: false });
      case "conversations.info": {
        if (this.noChannelScope) return json({ ok: false, error: "missing_scope", needed: "channels:read" });
        const id = args.channel ?? "";
        if (this.dms.has(id)) return json({ ok: true, channel: { id, is_im: true, user: this.dms.get(id) } });
        return this.channels.has(id) ? json({ ok: true, channel: { id, name: this.channels.get(id) } }) : json({ ok: false, error: "channel_not_found" });
      }
      case "users.info": {
        const name = this.users.get(args.user ?? "");
        return name ? json({ ok: true, user: { id: args.user, name: name.toLowerCase(), real_name: name, profile: { display_name: name, real_name: name } } }) : json({ ok: false, error: "user_not_found" });
      }
      case "chat.postMessage": {
        const m: FakeMessage = { channel: args.channel!, ts: this.ts(), ...(args.thread_ts ? { thread: args.thread_ts } : {}), user: this.bot.userId, botId: this.bot.botId, text: args.text ?? "",
          ...(args.blocks ? { blocks: JSON.parse(args.blocks) as Record<string, unknown>[] } : {}),
          ...(args.metadata ? { metadata: JSON.parse(args.metadata) as FakeMessage["metadata"] } : {}) };
        this.messages.push(m);
        return json({ ok: true, channel: m.channel, ts: m.ts, message: { ts: m.ts, text: m.text } });
      }
      case "chat.update": {
        const m = this.find(args.channel!, args.ts!);
        if (!m) return json({ ok: false, error: "message_not_found" });
        if (m.botId !== this.bot.botId) return json({ ok: false, error: "cant_update_message" });
        if (m.streaming) return json({ ok: false, error: "message_is_streaming" });
        m.text = args.text ?? m.text;
        if (args.blocks !== undefined) m.blocks = JSON.parse(args.blocks) as Record<string, unknown>[];
        // As in Slack, an update without metadata keeps the message's own.
        if (args.metadata !== undefined) m.metadata = JSON.parse(args.metadata) as FakeMessage["metadata"];
        return json({ ok: true, channel: m.channel, ts: m.ts, text: m.text });
      }
      case "chat.startStream": {
        if (this.noStream || !args.thread_ts) return json({ ok: false, error: "invalid_thread_ts" });
        if (!args.channel!.startsWith("D") && (!args.recipient_user_id || !args.recipient_team_id)) return json({ ok: false, error: "missing_recipient_user_id" });
        const m: FakeMessage = { channel: args.channel!, ts: this.ts(), thread: args.thread_ts, user: this.bot.userId, botId: this.bot.botId, text: "", markdown: args.markdown_text ?? "", streaming: true };
        this.messages.push(m);
        return json({ ok: true, channel: m.channel, ts: m.ts });
      }
      case "chat.appendStream": case "chat.stopStream": {
        const m = this.find(args.channel!, args.ts!);
        if (!m) return json({ ok: false, error: "message_not_found" });
        if (!m.streaming) return json({ ok: false, error: "message_not_in_streaming_state" });
        m.markdown = (m.markdown ?? "") + (args.markdown_text ?? "");
        if (method === "chat.stopStream") m.streaming = false;
        return json({ ok: true, channel: m.channel, ts: m.ts });
      }
      case "reactions.add": {
        const live = this.reactions.find(r => r.channel === args.channel && r.ts === args.timestamp && r.name === args.name && !r.removed);
        if (live) return json({ ok: false, error: "already_reacted" });
        this.reactions.push({ channel: args.channel!, ts: args.timestamp!, name: args.name!, removed: false });
        return json({ ok: true });
      }
      case "reactions.remove": {
        const live = this.reactions.find(r => r.channel === args.channel && r.ts === args.timestamp && r.name === args.name && !r.removed);
        if (!live) return json({ ok: false, error: "no_reaction" });
        live.removed = true;
        return json({ ok: true });
      }
      case "assistant.threads.setStatus":
        this.statuses.push({ channel: args.channel_id!, thread: args.thread_ts!, status: args.status ?? "" });
        return json({ ok: true });
      case "conversations.replies": {
        if (this.noHistory) return json({ ok: false, error: "missing_scope" });
        const thread = this.messages.filter(m => m.channel === args.channel && (m.ts === args.ts || m.thread === args.ts));
        // Slack returns a message's metadata only when asked for it.
        const metadata = args.include_all_metadata === "true";
        return json({ ok: true, messages: thread.map(m => ({ type: "message", ts: m.ts, text: m.markdown ?? m.text, ...(m.thread ? { thread_ts: m.thread } : {}), ...(m.botId ? { bot_id: m.botId } : {}), ...(m.user ? { user: m.user } : {}),
          ...(metadata && m.metadata ? { metadata: m.metadata } : {}) })), has_more: false });
      }
      case "files.info": {
        const f = this.files.get(args.file ?? "");
        return f ? json({ ok: true, file: { id: args.file, name: f.name, mimetype: f.mimetype, size: f.bytes.byteLength, url_private_download: `https://files.slack.com/files-pri/${this.team}-${args.file}/download/${f.name}` } })
          : json({ ok: false, error: "file_not_found" });
      }
      case "files.getUploadURLExternal": {
        const id = this.id("F0UP");
        this.files.set(id, { name: args.filename!, mimetype: "application/octet-stream", bytes: new Uint8Array() });
        return json({ ok: true, upload_url: `https://files.slack.com/upload/v1/${id}`, file_id: id });
      }
      case "files.completeUploadExternal": {
        const list = JSON.parse(args.files ?? "[]") as { id: string; title?: string }[];
        for (const f of list) { const known = this.files.get(f.id); if (!known?.bytes.byteLength) return json({ ok: false, error: "file_not_found" }); known.shared = true; }
        if (args.channel_id) {
          this.messages.push({ channel: args.channel_id, ts: this.ts(), ...(args.thread_ts ? { thread: args.thread_ts } : {}), user: this.bot.userId, botId: this.bot.botId,
            text: args.initial_comment ?? "", files: list.map(f => f.id) });
        }
        return json({ ok: true, files: list.map(f => ({ id: f.id, title: f.title ?? "" })) });
      }
    }
    return json({ ok: false, error: "unknown_method" });
  }

  private async filesHost(u: URL, init: RequestInit, token: string): Promise<Response> {
    let m: RegExpExecArray | null;
    if ((init.method ?? "GET") === "POST" && (m = /^\/upload\/v1\/([^/]+)$/.exec(u.pathname))) {
      const f = this.files.get(m[1]!);
      if (!f) return new Response("invalid upload", { status: 404 });
      f.bytes = new Uint8Array(init.body as Uint8Array);
      return new Response(`OK - ${f.bytes.byteLength}`, { status: 200, headers: { "content-type": "text/plain" } });
    }
    if ((m = /^\/files-pri\/[^-]+-([^/]+)\//.exec(u.pathname))) {
      // Without the bot token Slack answers with its sign-in page.
      if (token !== this.botToken) return new Response("<html>sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
      const f = this.files.get(m[1]!);
      if (!f) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(f.bytes), { status: 200, headers: { "content-type": f.mimetype, "content-length": String(f.bytes.byteLength) } });
    }
    return new Response("not found", { status: 404 });
  }
}

export class FakeSocket {
  readyState = 1;
  private listeners = new Map<string, Listener[]>();
  constructor(private readonly fake: FakeSlack, readonly url: string) { fake.open(this); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  emit(type: string, event: { data?: unknown; code?: number; reason?: string }) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  push(message: unknown) { if (this.readyState === 1) this.emit("message", { data: JSON.stringify(message) }); }
  send(data: string) { if (this.readyState === 1) this.fake.receive(data); }
  close(code = 1000) { this.serverClose(code); }
  serverClose(code: number, reason = "") {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }
}
