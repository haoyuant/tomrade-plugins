import type { Net } from "./api.js";
import type { TButton, TCallback, TChat, TEntity, TFile, TKeyboard, TMessage, TUpdate, TUser } from "./wire.js";

/** A Bot API call the fake received. */
export interface FakeCall { method: string; params: Record<string, unknown>; at: number }
/** A message as the fake keeps it; a bot's message also keeps the HTML it was sent with. */
export interface FakeMessage extends TMessage { html?: string; file?: { field: "photo" | "document"; name: string; size: number; type: string } }

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ ok: true, result });
const refuse = (code: number, description: string, parameters?: Record<string, unknown>) => json({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }, code);
const unreachable = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "blockquote", "tg-spoiler", "span"]);

/**
 * Telegram's HTML parse mode, strictly: known tags, closed in order, and links
 * only to schemes Telegram opens. The text a person would see, or why it is refused.
 */
export function parseHtml(html: string): { text: string } | { error: string } {
  const stack: string[] = [];
  let text = "";
  const re = /<(\/?)([a-z-]+)([^>]*)>|([^<]+)|</gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[4] !== undefined) { text += m[4].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&"); continue; }
    if (m[2] === undefined) return { error: "Bad Request: can't parse entities: unexpected '<'" };
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (stack.pop() !== name) return { error: `Bad Request: can't parse entities: can't find end tag corresponding to start tag "${name}"` };
      continue;
    }
    if (!TAGS.has(name)) return { error: `Bad Request: can't parse entities: unsupported start tag "${name}"` };
    if (name === "a" && !/^\s+href="(https?|tg):\/\//i.test(m[3] ?? "")) return { error: "Bad Request: can't parse entities: unsupported URL protocol" };
    stack.push(name);
  }
  return stack.length ? { error: `Bad Request: can't parse entities: can't find end tag for "${stack.at(-1)}"` } : { text };
}

type Waiting = { end(res: Response): void; fail(e: unknown): void };

/**
 * The Bot API in memory: getUpdates long polling with offsets that drop what
 * they pass, a webhook and a second reader that conflict with it, messages,
 * edits, drafts, reactions, callback answers, commands, files both ways, and
 * flood control. For tests and the plugin's own scenario; never shipped as the adapter.
 */
export class FakeTelegram {
  readonly token = "123456789:AAFakeTokenForTomradeTests_0123456789";
  readonly bot: TUser = { id: 123456789, is_bot: true, first_name: "Tomrade Bot", username: "tomrade_bot" };
  readonly ann: TUser = { id: 1001, is_bot: false, first_name: "Ann", last_name: "Lee", language_code: "en" };
  readonly bob: TUser = { id: 1002, is_bot: false, first_name: "Bob", language_code: "zh-hans" };
  readonly calls: FakeCall[] = [];
  /** Updates Telegram still holds, oldest first. */
  readonly pending: TUpdate[] = [];
  /** Every update id handed out by getUpdates, in order, repeats included. */
  readonly served: number[] = [];
  readonly messages = new Map<string, FakeMessage>();
  readonly drafts: { chat: number; draft: number; text: string; thread?: number }[] = [];
  readonly reactions = new Map<string, string>();
  readonly actions: { chat: number; action: string; thread?: number }[] = [];
  /** Callback answers by query id, with when the button was pressed and answered. */
  readonly answers = new Map<string, { pressed: number; at?: number; text?: string }>();
  readonly files = new Map<string, { bytes: Uint8Array; size: number }>();
  readonly forums = new Set<number>();
  commands: { command: string; description: string }[] | null = null;
  webhook = "";
  /** When set, sendMessageDraft is not known, as on an older Bot API. */
  noDrafts = false;
  /** When set, photos are refused, as Telegram does with odd dimensions. */
  refusePhotos = false;
  private ids = 100;
  private updateId = 5000;
  private queries = 0;
  private offline = 0;
  private waiting: Waiting | null = null;
  private fail: { match: (c: FakeCall) => boolean; code: number; description: string; retryAfter?: number; times: number }[] = [];

  net(): Net { return { fetch: (input, init) => this.fetch(String(input), init) }; }

  where(method: string) { return this.calls.filter(c => c.method === method); }

  /** Answers the next calls `match` picks with Telegram's error `code`; a 429 carries retry_after. */
  failNext(match: (c: FakeCall) => boolean, code: number, description: string, opts: { retryAfter?: number; times?: number } = {}) {
    this.fail.push({ match, code, description, ...(opts.retryAfter !== undefined ? { retryAfter: opts.retryAfter } : {}), times: opts.times ?? 1 });
  }

  /** A poll waiting now breaks off, and the network fails for the next `times` requests. */
  drop(times = 0) {
    this.offline = times;
    const w = this.waiting;
    this.waiting = null;
    w?.fail(unreachable());
  }

  private key = (chat: number, id: number) => `${chat}:${id}`;
  private push(update: Omit<TUpdate, "update_id">) {
    const u = { update_id: ++this.updateId, ...update } as TUpdate;
    this.pending.push(u);
    this.wake();
    return u.update_id;
  }

  private wake() {
    const w = this.waiting;
    if (!w || !this.pending.length) return;
    this.waiting = null;
    w.end(this.serve(this.pending.slice(0, 100)));
  }

  private serve(updates: TUpdate[]) {
    this.served.push(...updates.map(u => u.update_id));
    return ok(structuredClone(updates));
  }

  private chatOf(id: number): TChat {
    return id > 0 ? { id, type: "private" } : { id, type: "supergroup", title: "Team", ...(this.forums.has(id) ? { is_forum: true } : {}) };
  }

  /** A message as a reply carries it: without its own reply. */
  private snapshot(chat: number, id: number): TMessage | undefined {
    const m = this.messages.get(this.key(chat, id));
    if (!m) return undefined;
    const { reply_to_message: _, html: __, file: ___, ...rest } = m;
    return structuredClone(rest);
  }

  /** Entities Telegram finds by itself: a leading command and @usernames. */
  private entitiesOf(text: string): TEntity[] {
    const out: TEntity[] = [];
    const command = /^\/[a-z0-9_]+(@[a-z0-9_]+)?/i.exec(text);
    if (command) out.push({ type: "bot_command", offset: 0, length: command[0].length });
    for (const m of text.matchAll(/(^|[^\w/])(@[a-z0-9_]{3,})/gi)) out.push({ type: "mention", offset: m.index + m[1]!.length, length: m[2]!.length });
    return out;
  }

  /** A forum topic opened by `by`, whose opening message every message in it replies to. */
  topic(chat: number, name: string, by: TUser = this.ann) {
    this.forums.add(chat);
    const id = ++this.ids;
    this.messages.set(this.key(chat, id), { message_id: id, message_thread_id: id, is_topic_message: true, from: by, chat: this.chatOf(chat), date: now(), forum_topic_created: { name } });
    return id;
  }

  /**
   * A person sends a message: in their direct chat unless `chat` names a group
   * (a negative id). `topic` writes it in a forum topic, `replyTo` replies.
   */
  message(o: { from: TUser; chat?: number; text?: string; caption?: string; entities?: TEntity[]; topic?: number; replyTo?: number;
    photo?: { id: string; size?: number }; document?: TFile; id?: number }) {
    const chat = o.chat ?? o.from.id;
    const id = o.id ?? ++this.ids;
    const body = o.text ?? o.caption;
    const entities = o.entities ?? (body ? this.entitiesOf(body) : []);
    const replied = o.replyTo !== undefined ? this.snapshot(chat, o.replyTo) : o.topic !== undefined ? this.snapshot(chat, o.topic) : undefined;
    const m: FakeMessage = {
      message_id: id, from: o.from, chat: this.chatOf(chat), date: now(),
      ...(o.topic !== undefined ? { message_thread_id: o.topic, is_topic_message: true } : {}),
      ...(replied ? { reply_to_message: replied } : {}),
      ...(o.text !== undefined ? { text: o.text, ...(entities.length ? { entities } : {}) } : {}),
      ...(o.caption !== undefined ? { caption: o.caption, ...(entities.length ? { caption_entities: entities } : {}) } : {}),
      ...(o.photo ? { photo: [{ file_id: `${o.photo.id}-small`, width: 90, height: 90, file_size: 100 }, { file_id: o.photo.id, width: 800, height: 600, ...(o.photo.size ? { file_size: o.photo.size } : {}) }] } : {}),
      ...(o.document ? { document: o.document } : {})
    };
    this.messages.set(this.key(chat, id), m);
    const updateId = this.push({ message: structuredClone(m) });
    return { id, updateId, message: m };
  }

  /** The same message handed over again under a new update, as Telegram may do. */
  redeliver(message: TMessage) { return this.push({ message: structuredClone(message) }); }

  /** A person edits their message. */
  edit(chat: number, id: number, text: string) {
    const m = this.messages.get(this.key(chat, id))!;
    m.text = text;
    m.edit_date = now();
    return this.push({ edited_message: structuredClone(m) });
  }

  /** A person presses a button of the bot's message, picked by its label or its data. */
  press(o: { chat: number; messageId: number; from: TUser; label?: string; data?: string }) {
    const m = this.messages.get(this.key(o.chat, o.messageId));
    const button = m?.reply_markup?.inline_keyboard.flat().find(b => (o.data !== undefined ? b.callback_data === o.data : b.text === o.label || b.text.endsWith(` ${o.label}`)));
    const id = `q${++this.queries}`;
    const query: TCallback = { id, from: o.from, ...(m ? { message: this.snapshot(o.chat, o.messageId)! } : {}), data: o.data ?? button?.callback_data ?? "" };
    this.answers.set(id, { pressed: Date.now() });
    this.push({ callback_query: query });
    return id;
  }

  /** The bot's messages in a chat, oldest first. */
  posted(chat: number) {
    return [...this.messages.values()].filter(m => m.chat.id === chat && m.from?.id === this.bot.id).sort((a, b) => a.message_id - b.message_id);
  }

  /** A button of a message, by its label. */
  button(m: TMessage, label: string): TButton | undefined {
    return m.reply_markup?.inline_keyboard.flat().find(b => b.text === label || b.text.endsWith(` ${label}`));
  }

  // ── Bot API ──────────────────────────────────────────────────────────

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(u.pathname);
    if (file) {
      if (file[1] !== this.token) return new Response("Unauthorized", { status: 401 });
      const f = [...this.files.entries()].find(([id]) => `files/${id}` === file[2]);
      return f ? new Response(new Uint8Array(f[1].bytes)) : new Response("Not Found", { status: 404 });
    }
    const route = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
    if (!route) return refuse(404, "Not Found");
    let params: Record<string, unknown> = {};
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) params[k] = typeof v === "string" ? (/^[[{]/.test(v) ? JSON.parse(v) as unknown : v) : { name: (v as File).name, size: (v as File).size, type: (v as File).type };
    } else if (typeof init.body === "string") params = JSON.parse(init.body) as Record<string, unknown>;
    const method = route[2]!;
    const call: FakeCall = { method, params, at: Date.now() };
    this.calls.push(call);
    if (this.offline > 0) { this.offline--; throw unreachable(); }
    if (route[1] !== this.token) return refuse(401, "Unauthorized");
    const failing = this.fail.find(f => f.times > 0 && f.match(call));
    if (failing) {
      failing.times--;
      return refuse(failing.code, failing.description, failing.retryAfter !== undefined ? { retry_after: failing.retryAfter } : undefined);
    }
    const chat = Number(params.chat_id);
    const thread = params.message_thread_id === undefined ? undefined : Number(params.message_thread_id);
    switch (method) {
      case "getMe": return ok({ ...this.bot, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false });
      case "getWebhookInfo": return ok({ url: this.webhook, has_custom_certificate: false, pending_update_count: this.pending.length });
      case "getUpdates": return this.poll(params, init.signal ?? undefined);
      case "sendMessage": case "sendPhoto": case "sendDocument": return this.send(method, chat, thread, params);
      case "editMessageText": case "editMessageReplyMarkup": {
        const m = this.messages.get(this.key(chat, Number(params.message_id)));
        if (!m) return refuse(400, "Bad Request: message to edit not found");
        const markup = params.reply_markup as TKeyboard | undefined;
        const invalid = markup && this.badMarkup(markup);
        if (invalid) return refuse(400, invalid);
        let text = m.text, html = m.html;
        if (method === "editMessageText") {
          if (m.text === undefined) return refuse(400, "Bad Request: there is no text in the message to edit");
          const parsed = this.textOf(params);
          if ("error" in parsed) return refuse(400, parsed.error);
          ({ text, html } = parsed);
        }
        // Without a keyboard, an edit takes the old one away.
        const keyboard = markup?.inline_keyboard.length ? markup : undefined;
        if (text === m.text && html === m.html && JSON.stringify(keyboard) === JSON.stringify(m.reply_markup)) {
          return refuse(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
        }
        Object.assign(m, { text, html, edit_date: now() });
        if (keyboard) m.reply_markup = keyboard;
        else delete m.reply_markup;
        return ok(structuredClone(m));
      }
      case "sendMessageDraft": {
        if (this.noDrafts) return refuse(404, "Not Found");
        if (!(chat > 0)) return refuse(400, "Bad Request: TEXTDRAFT_PEER_INVALID");
        if (!Number.isInteger(params.draft_id) || params.draft_id === 0) return refuse(400, "Bad Request: draft_id must be non-zero");
        const parsed = this.textOf(params, true);
        if ("error" in parsed) return refuse(400, parsed.error);
        this.drafts.push({ chat, draft: Number(params.draft_id), text: parsed.text, ...(thread !== undefined ? { thread } : {}) });
        return ok(true);
      }
      case "setMessageReaction": {
        const emoji = (params.reaction as { emoji: string }[] | undefined)?.[0]?.emoji;
        if (emoji) this.reactions.set(this.key(chat, Number(params.message_id)), emoji);
        else this.reactions.delete(this.key(chat, Number(params.message_id)));
        return ok(true);
      }
      case "sendChatAction":
        this.actions.push({ chat, action: String(params.action), ...(thread !== undefined ? { thread } : {}) });
        return ok(true);
      case "answerCallbackQuery": {
        const a = this.answers.get(String(params.callback_query_id));
        if (!a || a.at !== undefined) return refuse(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
        a.at = Date.now();
        if (params.text) a.text = String(params.text);
        return ok(true);
      }
      case "setMyCommands": {
        const commands = params.commands as { command: string; description: string }[];
        if (commands.some(c => !/^[a-z0-9_]{1,32}$/.test(c.command) || !c.description || c.description.length > 256)) return refuse(400, "Bad Request: BOT_COMMAND_INVALID");
        this.commands = commands;
        return ok(true);
      }
      case "getFile": {
        const f = this.files.get(String(params.file_id));
        if (!f) return refuse(400, "Bad Request: invalid file_id");
        if (f.size > 20 * 1024 * 1024) return refuse(400, "Bad Request: file is too big");
        return ok({ file_id: params.file_id, file_unique_id: `u-${String(params.file_id)}`, file_size: f.size, file_path: `files/${String(params.file_id)}` });
      }
      case "deleteMessage":
        return this.messages.delete(this.key(chat, Number(params.message_id))) ? ok(true) : refuse(400, "Bad Request: message to delete not found");
    }
    return refuse(404, "Not Found");
  }

  private textOf(params: Record<string, unknown>, empty = false): { text: string; html?: string } | { error: string } {
    const raw = String(params.text ?? "");
    const parsed = params.parse_mode === "HTML" ? parseHtml(raw) : { text: raw };
    if ("error" in parsed) return parsed;
    if (!empty && !parsed.text.trim()) return { error: "Bad Request: message text is empty" };
    if (parsed.text.length > 4096) return { error: "Bad Request: message is too long" };
    return { text: parsed.text, ...(params.parse_mode === "HTML" ? { html: raw } : {}) };
  }

  private badMarkup(markup: TKeyboard): string | null {
    for (const b of markup.inline_keyboard.flat()) {
      if (!b.text) return "Bad Request: text buttons are unallowed in the inline keyboard";
      if (b.callback_data !== undefined && (!b.callback_data || Buffer.byteLength(b.callback_data) > 64)) return "Bad Request: BUTTON_DATA_INVALID";
      if (b.url !== undefined && !/^(https?|tg):\/\//i.test(b.url)) return "Bad Request: BUTTON_URL_INVALID";
    }
    return null;
  }

  private send(method: string, chat: number, thread: number | undefined, params: Record<string, unknown>) {
    if (thread !== undefined && !this.forums.has(chat)) return refuse(400, "Bad Request: message thread not found");
    const reply = params.reply_parameters as { message_id: number; allow_sending_without_reply?: boolean } | undefined;
    const replied = reply ? this.snapshot(chat, reply.message_id) : undefined;
    if (reply && !replied && !reply.allow_sending_without_reply) return refuse(400, "Bad Request: message to be replied not found");
    const markup = params.reply_markup as (TKeyboard & { force_reply?: boolean }) | undefined;
    const invalid = markup?.inline_keyboard && this.badMarkup(markup);
    if (invalid) return refuse(400, invalid);
    const id = ++this.ids;
    const m: FakeMessage = { message_id: id, from: this.bot, chat: this.chatOf(chat), date: now(),
      ...(thread !== undefined ? { message_thread_id: thread, is_topic_message: true } : {}), ...(replied ? { reply_to_message: replied } : {}),
      ...(markup?.inline_keyboard?.length ? { reply_markup: { inline_keyboard: markup.inline_keyboard } } : {}) };
    if (method === "sendMessage") {
      const parsed = this.textOf(params);
      if ("error" in parsed) return refuse(400, parsed.error);
      Object.assign(m, parsed);
    } else {
      const field = method === "sendPhoto" ? "photo" : "document";
      if (field === "photo" && this.refusePhotos) return refuse(400, "Bad Request: PHOTO_INVALID_DIMENSIONS");
      const f = params[field] as { name: string; size: number; type: string };
      m.file = { field, ...f };
    }
    this.messages.set(this.key(chat, id), m);
    return ok(structuredClone(m));
  }

  private poll(params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> | Response {
    if (this.webhook) return refuse(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
    // A newer getUpdates ends one still waiting.
    const before = this.waiting;
    this.waiting = null;
    before?.end(refuse(409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"));
    if (typeof params.offset === "number") {
      const offset = params.offset;
      for (let i = this.pending.length - 1; i >= 0; i--) if (this.pending[i]!.update_id < offset) this.pending.splice(i, 1);
    }
    const limit = Number(params.limit ?? 100);
    const timeout = Number(params.timeout ?? 0);
    if (this.pending.length || !timeout) return this.serve(this.pending.slice(0, limit));
    return new Promise<Response>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); if (this.waiting === w) this.waiting = null; };
      const w: Waiting = { end: res => { done(); resolve(res); }, fail: e => { done(); reject(e); } };
      const timer = setTimeout(() => w.end(this.serve([])), timeout * 1000);
      const aborted = () => w.fail(new DOMException("This operation was aborted", "AbortError"));
      signal?.addEventListener("abort", aborted, { once: true });
      this.waiting = w;
    });
  }
}

const now = () => Math.floor(Date.now() / 1000);
