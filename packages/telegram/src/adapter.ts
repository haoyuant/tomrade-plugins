import { createHash } from "node:crypto";
import type { ImAdapter, ImAdapterSession, ImAddress, ImCapabilities, ImContent, ImInbound } from "@tomradex/plugin-sdk";
import { Api, net, TelegramError, unchanged, unparsable, untouched, type Net } from "./api.js";
import { clip, Codec, esc, inputOf, labelOf, plainOf, readSelect, Recent, render, retick } from "./markup.js";
import { Poller } from "./poller.js";
import { activationOf, actorOf, addressOf, contextOf, filesOf, isPrivate, nameOf, quotedOf, REACTIONS, readText, type TCallback, type TMessage, type TUpdate, type TUser } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  // One size for both ways: a bot downloads up to 20 MB (it could upload 50); larger files go as a link.
  maxTextLength: 4096, maxFileBytes: 20 * 1024 * 1024,
  // A group reply quotes the message that asked; a forum topic is answered in that topic, and the bot opens one per ticket being worked (`topics`).
  threads: false, topics: true, reactions: true, typing: true, stream: "native",
  select: true, multiSelect: true, textInput: true, cards: true, cardUpdate: true,
  nativeCommands: true, ephemeral: false, markdown: "telegram-html",
  // About one message a second in a chat, short bursts allowed; groups get their 20 a minute paced in the adapter.
  rateLimit: { messages: 3, windowMs: 3_000 }
};

type IO = Parameters<ImAdapter["open"]>[1];

const GROUP_RATE = { messages: 20, windowMs: 60_000 };
/** Photos up to 10 MB go as photos; anything else, or a photo Telegram refuses, as a file. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_BYTES = 10 * 1024 * 1024;
/** The most an attachment reference may claim; a larger file is named in the text instead. */
const REF_BYTES = 32 * 1024 * 1024;
const TOKEN = /^\d+:[\w-]{20,}$/;
const TOPIC_NAME = 128;

/** Changes to one draft id animate; the operation names it, so a retried start keeps it. */
const draftOf = (operationId: string) => (createHash("sha256").update(operationId).digest().readUInt32BE(0) % 2_147_483_646) + 1;
const zh = (u: TUser) => /^zh/i.test(u.language_code ?? "");

export interface TelegramOptions { net?: Net; timeoutS?: number; backoffMs?: number }

export async function openTelegram(connectionId: string, io: IO, opts: TelegramOptions = {}): Promise<ImAdapterSession> {
  const token = io.credentials.botToken?.trim() ?? "";
  if (!token) throw new Error("The bot token is needed");
  if (!TOKEN.test(token)) throw new Error("That is not a bot token from @BotFather; it looks like 123456789:AA…");
  const api = new Api(token, opts.net ?? net());

  // Who the token signs in as; a wrong one fails here, in Telegram's words.
  let me: TUser;
  try { me = await api.call<TUser>("getMe", {}, { idempotent: true }); }
  catch (e) { throw e instanceof TelegramError && e.disposition === "permanent" ? new Error(`Telegram refused the bot token: ${e.description}`) : e; }
  const bot = { id: me.id, username: me.username ?? "" };
  // A webhook keeps every update from getUpdates; deleting it would break whatever serves it, so the person decides.
  const hook = await api.call<{ url?: string }>("getWebhookInfo", {}, { idempotent: true });
  if (hook.url) throw new Error("This bot hands its updates to a webhook, so Telegram gives none to Tomrade. Use a bot made for Tomrade, or remove the webhook first.");

  const codec = new Codec();
  /** Parts already posted per operation, so a retry after a partial failure posts nothing twice. */
  const sent = new Recent<string>(1000);
  /** Option values per select token; after a restart the keyboard's labels stand in. */
  const values = new Recent<string[]>(500);
  /** Ticked options per multi-select token, ahead of a keyboard that may lag behind quick taps. */
  const picked = new Recent<Set<number>>(200);
  /** Answer prompts this session posted, by chat and message. */
  const prompts = new Recent<string>(200);
  /** The text of messages handed over, so only a real edit is reported. */
  const texts = new Recent<string>(1000);
  const reacted = new Recent<string>(500);
  const paced = new Map<string, number[]>();
  const streams = new Map<string, { text: string; draft?: number }>();
  /** What each topic the bot opened was last given; not known after a restart, when Telegram's "not modified" settles it. */
  const topics = new Recent<{ name?: string; closed?: boolean }>(500);
  let drafts = true;

  const receive = (event: ImInbound) => io.receive(event).then(() => {}, () => {});
  const threadOf = (address: ImAddress, threadId?: string) => {
    const t = Number(threadId ?? address.topicId);
    return Number.isInteger(t) && t > 0 ? { message_thread_id: t } : {};
  };

  /** Attachment references with their sizes; a file too large to fetch is named in the text instead. */
  const attach = async (m: TMessage) => {
    const refs: { id: string; name: string; mimeType: string; size: number }[] = [];
    const notes: string[] = [];
    for (const f of filesOf(m).slice(0, 8)) {
      const size = f.size ?? await api.call<{ file_size?: number }>("getFile", { file_id: f.id }, { idempotent: true }).then(r => r.file_size, () => undefined);
      if (size && size <= REF_BYTES && f.id.length <= 256) refs.push({ id: f.id, name: f.name.slice(0, 255), mimeType: f.mimeType.slice(0, 128), size });
      else notes.push(`[${f.name}${size ? `, ${Math.ceil(size / 1048576)} MB` : ""}: too large for a Telegram bot to fetch]`);
    }
    return { refs, notes };
  };

  const onMessage = async (m: TMessage) => {
    const from = m.from;
    if (!from || from.is_bot || m.is_automatic_forward || m.chat.type === "channel") return;
    const read = readText(m, bot);
    if (read.command === "other") return;
    const chat = String(m.chat.id);
    const address = addressOf(m);
    const actor = actorOf(from);
    // The id Telegram gives the message, not the update's: it never repeats, whichever update carries it.
    const eventId = `m:${chat}:${m.message_id}`;
    const quoted = quotedOf(m);
    // A reply to an answer prompt, or to a card that asks for a written answer, is that answer.
    if (quoted?.from?.id === bot.id && read.text && !read.text.startsWith("/")) {
      const key = `${chat}:${quoted.message_id}`;
      const prompt = prompts.get(key);
      const answerTo = prompt ?? inputOf(quoted.reply_markup, codec)?.control.token;
      if (answerTo) {
        prompts.delete(key);
        await receive({ kind: "action", eventId, token: answerTo, value: read.text, actor, address });
        if (prompt) void api.call("deleteMessage", { chat_id: m.chat.id, message_id: quoted.message_id }, { idempotent: true }).catch(() => {});
        return;
      }
    }
    const activation = activationOf(m, bot, read);
    if (activation === "ambient" && !read.text) return;
    const { refs, notes } = activation === "ambient" ? { refs: [], notes: [] } : await attach(m);
    // Telegram sends a bare /start from the Start button, or when the bot joins a group; it gets the commands, not a ticket to start.
    const said = /^\/start$/i.test(read.text) ? "/help" : read.text;
    const text = [said, ...notes].filter(Boolean).join("\n");
    if (!text && !refs.length) return;
    if (activation !== "ambient") texts.set(`${chat}:${m.message_id}`, read.text);
    const context = activation === "ambient" ? [] : contextOf(m, bot);
    await receive({
      kind: "message", eventId, messageId: String(m.message_id), text, activation, actor, address,
      ...(refs.length ? { attachments: refs } : {}),
      ...(quoted ? { replyTo: String(quoted.message_id) } : {}),
      ...(context.length ? { context } : {})
    });
  };

  const onEdit = async (m: TMessage) => {
    if (!m.from || m.from.is_bot) return;
    const key = `${m.chat.id}:${m.message_id}`;
    const before = texts.get(key);
    const now = readText(m, bot).text;
    // Telegram also reports changes nobody made to the text; only a real edit of a message that was handed over counts.
    if (before === undefined || before === now) return;
    texts.set(key, now);
    await receive({ kind: "edit", eventId: `e:${key}:${m.edit_date ?? 0}`, messageId: String(m.message_id), actor: actorOf(m.from), address: addressOf(m) });
  };

  /** Stops the button's spinner; done first, before anything slower. */
  const answer = (q: TCallback, text?: string) => void api.call("answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }, { idempotent: true }).catch(() => {});

  const onCallback = async (q: TCallback) => {
    const control = q.data ? codec.unpack(q.data) : null;
    const m = q.message;
    if (!control || !m || control.kind === "x") { answer(q); return; }
    const address = addressOf(m);
    const actor = actorOf(q.from);
    const eventId = `c:${q.id}`;
    // A message too old to show comes without its content.
    const keyboard = m.date ? m.reply_markup : undefined;
    const { token, index } = control;
    switch (control.kind) {
      case "b":
        answer(q);
        await receive({ kind: "action", eventId, token, actor, address });
        return;
      case "o": {
        answer(q);
        const value = values.get(token)?.[index!] ?? readSelect(keyboard, codec, token).labels.get(index!);
        if (value !== undefined) await receive({ kind: "action", eventId, token, value, actor, address });
        return;
      }
      case "m": {
        answer(q);
        const set = picked.get(token) ?? readSelect(keyboard, codec, token).picked;
        if (set.has(index!)) set.delete(index!);
        else set.add(index!);
        picked.set(token, set);
        if (keyboard) await api.call("editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id, reply_markup: retick(keyboard, codec, token, set) }, { idempotent: true }).catch(() => {});
        return;
      }
      case "M": {
        const shown = readSelect(keyboard, codec, token);
        const set = picked.get(token) ?? shown.picked;
        if (!set.size) { answer(q, zh(q.from) ? "请至少选一项" : "Pick at least one"); return; }
        answer(q);
        const all = values.get(token);
        const value = [...set].sort((a, b) => a - b).map(i => all?.[i] ?? shown.labels.get(i)).filter((v): v is string => v !== undefined);
        picked.delete(token);
        await receive({ kind: "action", eventId, token, value, actor, address });
        return;
      }
      case "i": {
        answer(q);
        const pressed = keyboard?.inline_keyboard.flat().find(b => b.callback_data === q.data);
        const label = pressed ? labelOf(pressed) : zh(q.from) ? "你的回答" : "Your answer";
        // In a group the prompt names whom it asks, so only their reply box opens.
        const mention = isPrivate(m.chat.id) ? "" : `<a href="tg://user?id=${q.from.id}">${esc(nameOf(q.from))}</a> `;
        try {
          const prompt = await api.call<TMessage>("sendMessage", {
            chat_id: m.chat.id, ...threadOf(address), text: `${mention}✍️ ${esc(label)}`, parse_mode: "HTML",
            reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
            reply_markup: { force_reply: true, selective: true, input_field_placeholder: zh(q.from) ? "回复这条消息作答" : "Reply to answer" }
          });
          prompts.set(`${m.chat.id}:${prompt.message_id}`, token);
        } catch { /* a reply to the card itself still answers */ }
        return;
      }
    }
  };

  const onUpdate = async (u: TUpdate) => {
    try {
      if (u.message) await onMessage(u.message);
      else if (u.edited_message) await onEdit(u.edited_message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch { /* an update this adapter cannot read is passed over, not fetched forever */ }
  };

  const poller = new Poller(api, { update: onUpdate, state: (state, detail) => io.status(state, detail) },
    { ...(opts.timeoutS !== undefined ? { timeoutS: opts.timeoutS } : {}), ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}) });
  io.signal.addEventListener("abort", () => poller.stop(), { once: true });
  if (io.signal.aborted) poller.stop();
  else poller.start();

  /** Groups get Telegram's 20 messages a minute here, so a busy group waits rather than being refused. */
  const pace = (chat: string) => {
    if (isPrivate(chat)) return;
    const now = Date.now();
    const recent = (paced.get(chat) ?? []).filter(t => now - t < GROUP_RATE.windowMs);
    if (recent.length >= GROUP_RATE.messages) throw new TelegramError("Telegram allows a bot 20 messages a minute in a group", "retryable", 429, "", recent[0]! + GROUP_RATE.windowMs - now + 10);
    recent.push(now);
    paced.set(chat, recent);
  };

  /** Sends HTML; if Telegram cannot parse it, the same words go as plain text. */
  const html = async <T>(method: string, params: Record<string, unknown>, text: string, idempotent: boolean): Promise<T> => {
    try { return await api.call<T>(method, { ...params, text, parse_mode: "HTML" }, { idempotent }); }
    catch (e) {
      if (!unparsable(e)) throw e;
      return api.call<T>(method, { ...params, text: plainOf(text) }, { idempotent });
    }
  };

  const remember = (content: ImContent) => {
    for (const el of content.elements ?? []) if (el.type === "select") { values.set(el.token, el.options.map(o => o.value)); picked.delete(el.token); }
  };

  const sendText = async (chat: string, extra: Record<string, unknown>, content: ImContent) => {
    const r = render(content, codec);
    remember(content);
    pace(chat);
    const message = await html<TMessage>("sendMessage", { chat_id: Number(chat), ...extra, link_preview_options: { is_disabled: true }, ...(r.keyboard ? { reply_markup: r.keyboard } : {}) }, r.text, false);
    return String(message.message_id);
  };

  /** Rewrites a message in place; its keyboard goes with the old content unless the new one brings its own. */
  const edit = async (chat: string, messageId: string, content: ImContent) => {
    const r = render(content, codec);
    remember(content);
    pace(chat);
    try {
      await html("editMessageText", { chat_id: Number(chat), message_id: Number(messageId), link_preview_options: { is_disabled: true }, reply_markup: r.keyboard ?? { inline_keyboard: [] } }, r.text, true);
    } catch (e) { if (!unchanged(e)) throw e; }
  };

  const sendFile = async (chat: string, extra: Record<string, unknown>, f: NonNullable<ImContent["files"]>[number]) => {
    const bytes = await io.readOutboundFile(f.id);
    const form = (field: string) => {
      const data = new FormData();
      data.append("chat_id", chat);
      for (const [k, v] of Object.entries(extra)) data.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      data.append(field, new Blob([new Uint8Array(bytes)], { type: f.mimeType }), f.name);
      return data;
    };
    pace(chat);
    if (PHOTO_TYPES.has(f.mimeType) && bytes.byteLength <= PHOTO_BYTES) {
      try { return String((await api.call<TMessage>("sendPhoto", form("photo"))).message_id); }
      catch (e) { if (!(e instanceof TelegramError) || e.disposition !== "permanent") throw e; }
    }
    return String((await api.call<TMessage>("sendDocument", form("document"))).message_id);
  };

  /** Posts new content: the text with its keyboard, then each file. A part already posted for this operation is not posted again. */
  const post = async (operationId: string, address: ImAddress, threadId: string | undefined, replyTo: string | undefined, content: ImContent): Promise<string> => {
    const chat = address.conversationId;
    const thread = threadOf(address, threadId);
    const quote = Number(replyTo) > 0 ? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } } : {};
    const once = async (part: string, send: () => Promise<string>) => {
      const key = `${operationId}:${part}`;
      const known = sent.get(key);
      if (known) return known;
      const id = await send();
      sent.set(key, id);
      return id;
    };
    const files = content.files ?? [];
    let first: string | undefined;
    if (content.text || content.actions?.length || content.elements?.length || !files.length) first = await once("text", () => sendText(chat, { ...thread, ...quote }, content));
    for (const [i, f] of files.entries()) {
      const id = await once(`f${i}`, () => sendFile(chat, { ...thread, ...(first ? {} : quote) }, f));
      first ??= id;
    }
    return first!;
  };

  return {
    identity: { id: String(me.id), name: me.username ? `${me.first_name} (@${me.username})` : me.first_name },

    async deliver(d) {
      // A draft is no message: a reply still a draft at a restart is posted anew.
      if (d.replaceMessageId && !d.replaceMessageId.startsWith("draft:")) {
        await edit(d.address.conversationId, d.replaceMessageId, d.content);
        return { messageId: d.replaceMessageId };
      }
      return { messageId: await post(d.operationId, d.address, d.threadId, d.replyTo, d.content) };
    },

    download: ref => api.download(ref.id),

    async indicate({ address, threadId, state }) {
      // Telegram clears "typing" by itself, at the latest when the reply arrives.
      if (state === "idle") return;
      await api.call("sendChatAction", { chat_id: Number(address.conversationId), ...threadOf(address, threadId), action: "typing" }, { idempotent: true });
    },

    async react({ address, messageId, reaction }) {
      if (!(Number(messageId) > 0)) return;
      const key = `${address.conversationId}:${messageId}`;
      const emoji = REACTIONS[reaction];
      if (reacted.get(key) === emoji) return;
      // A bot sets one reaction per message; the next replaces it.
      await api.call("setMessageReaction", { chat_id: Number(address.conversationId), message_id: Number(messageId), reaction: [{ type: "emoji", emoji }] }, { idempotent: true });
      reacted.set(key, emoji);
    },

    stream: {
      /** In a direct chat the reply grows as a draft; in a group it is a message edited as it grows. */
      async start(d) {
        const chat = d.address.conversationId;
        if (isPrivate(chat) && drafts) {
          const draft = draftOf(d.operationId);
          try {
            await html("sendMessageDraft", { chat_id: Number(chat), ...threadOf(d.address, d.threadId), draft_id: draft }, d.content.text, true);
            streams.set(`${chat}:draft:${draft}`, { text: d.content.text, draft });
            return { messageId: `draft:${draft}` };
          } catch (e) {
            // A person who blocked the bot refuses everything; only a refused draft turns drafts off.
            if (!(e instanceof TelegramError) || e.disposition !== "permanent" || e.code === 403) throw e;
            // Replies grow by edits from now on.
            drafts = false;
          }
        }
        const id = await post(d.operationId, d.address, d.threadId, d.replyTo, { text: d.content.text || "…" });
        streams.set(`${chat}:${id}`, { text: d.content.text });
        return { messageId: id };
      },

      async append({ address, messageId, delta }) {
        const chat = address.conversationId;
        const s = streams.get(`${chat}:${messageId}`);
        // Not known after a restart: the final version settles it.
        if (!s) return;
        // The whole text each time: a lost update only delays what shows.
        s.text += delta;
        if (s.draft) { await html("sendMessageDraft", { chat_id: Number(chat), ...threadOf(address), draft_id: s.draft }, s.text, true); return; }
        pace(chat);
        try { await html("editMessageText", { chat_id: Number(chat), message_id: Number(messageId), link_preview_options: { is_disabled: true } }, s.text, true); }
        catch (e) { if (!unchanged(e)) throw e; }
      },

      async stop({ operationId, address, messageId, content }) {
        const chat = address.conversationId;
        streams.delete(`${chat}:${messageId}`);
        // A draft is only a preview; the reply itself must be sent as a message.
        if (messageId.startsWith("draft:")) return { messageId: await post(operationId, address, undefined, undefined, content) };
        await edit(chat, messageId, content);
        return { messageId };
      }
    },

    topics: {
      async open({ address, title }) {
        const chat = address.conversationId;
        if (isPrivate(chat)) throw new TelegramError("A direct chat has no topics", "permanent");
        const name = clip(title, TOPIC_NAME);
        pace(chat);
        // Not idempotent: a topic whose answer was lost may exist, so that is uncertain rather than opened twice.
        const topic = await api.call<{ message_thread_id: number }>("createForumTopic", { chat_id: Number(chat), name });
        topics.set(`${chat}:${topic.message_thread_id}`, { name, closed: false });
        return { topicId: String(topic.message_thread_id) };
      },

      async update({ address, title, closed }) {
        const chat = address.conversationId;
        const key = `${chat}:${address.topicId}`;
        const known = topics.get(key) ?? {};
        const name = clip(title, TOPIC_NAME);
        /** One change, remembered once it is made, so a retry sends only what is left. */
        const step = async (method: string, extra: Record<string, unknown>, made: { name?: string; closed?: boolean }) => {
          pace(chat);
          try { await api.call(method, { chat_id: Number(chat), message_thread_id: Number(address.topicId), ...extra }, { idempotent: true }); }
          catch (e) { if (!untouched(e)) throw e; }
          topics.set(key, Object.assign(known, made));
        };
        // Opened again before it is renamed, renamed before it is closed.
        if (!closed && known.closed !== false) await step("reopenForumTopic", {}, { closed: false });
        if (known.name !== name) await step("editForumTopic", { name }, { name });
        if (closed && known.closed !== true) await step("closeForumTopic", {}, { closed: true });
      }
    },

    async commands(list) {
      const commands = list.filter(c => /^[a-z0-9_]{1,32}$/.test(c.name)).slice(0, 100)
        .map(c => ({ command: c.name, description: clip(`${c.description}${c.args ? ` (${c.args})` : ""}`, 256) || c.name }));
      await api.call("setMyCommands", { commands }, { idempotent: true });
    },

    close() {
      poller.stop();
      streams.clear();
    }
  };
}
