import { createHash, randomBytes } from "node:crypto";
import type { ImAdapter, ImAdapterSession, ImCapabilities, ImContent, ImContextMessage, ImInbound } from "@tomradex/plugin-sdk";
import { answeredOf, clipBytes, controlOf, plain, planOf, THINKING, type Card } from "./card.js";
import { LongConnection, net, SERVER, STALE, STREAM_OVER, WecomError, type Frame, type Net } from "./gateway.js";
import { Budget, CONVERSATION, UPLOADS } from "./limit.js";
import { decrypt, extOf, fileName, mimeByName, parseMessage, quoteText, sniff, type FileRef, type WEvent, type WMessage } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  // Only a streaming reply changes after it is sent, and a template card only in answer to its own press.
  edit: false, buttons: true, inboundFiles: true, outboundFiles: true,
  // A message holds 20480 bytes of UTF-8; 6000 UTF-16 units never take more than 18000.
  maxTextLength: 6000, maxFileBytes: 20 * 1024 * 1024,
  // No topics: in a group a reply answers the callback that asked. "Thinking" is a stream placeholder.
  threads: false, reactions: false, typing: true, stream: "native",
  select: true, multiSelect: true, textInput: false, cards: true, cardUpdate: true,
  nativeCommands: false, ephemeral: false, markdown: "wecom",
  // WeCom's 30 a minute per conversation; the adapter keeps to its 1000 an hour too.
  rateLimit: { messages: 30, windowMs: 60_000 }
};

type IO = Parameters<ImAdapter["open"]>[1];
type Attachment = NonNullable<(ImInbound & { kind: "message" })["attachments"]>[number];
type OutFile = NonNullable<ImContent["files"]>[number];

/** Remembers the most recent `max` entries. */
class Recent<V> extends Map<string, V> {
  constructor(private readonly max: number) { super(); }
  override set(key: string, value: V) {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}

const hashOf = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 32);

/** A callback takes replies for 24 hours; a little less leaves room for the reply itself. */
const REPLY_MS = 23.5 * 3_600_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const IMAGE_BYTES = 10 * 1024 * 1024;
const CHUNK = 512 * 1024;
/** The IM layer takes attachments up to this size; a larger one is reported just past the limit, so it is refused with a reason. */
const INBOUND_MAX = 32 * 1024 * 1024;

export interface WecomOptions {
  net?: Net; backoffMs?: number; livenessMs?: number; pingMs?: number; ackMs?: number;
  /** Least time between two refreshes of one stream. */
  refreshMs?: number;
  /** How long a stream takes refreshes; WeCom ends it ten minutes after its first frame. */
  streamMs?: number;
  /** How long a thinking placeholder waits, once the turn is over, to be taken by a reply. */
  graceMs?: number;
  now?: () => number;
}

interface Callback { reqId: string; at: number; conv: string }
interface Stream {
  id: string; conv: string; reqId?: string; startedAt: number;
  /** All the text so far, and what WeCom shows of it. */
  text: string; shown: string; lastAt: number;
  /** Opened as a receipt and not yet taken by a reply. */
  placeholder: boolean;
  ended: boolean; over: boolean; busy: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export async function openWecom(connectionId: string, io: IO, opts: WecomOptions = {}): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const now = opts.now ?? Date.now;
  const botId = io.credentials.botId?.trim() ?? "";
  const secret = io.credentials.secret?.trim() ?? "";
  const server = io.credentials.server?.trim() || SERVER;
  if (!botId || !secret) throw new Error("The Bot ID and Secret are both needed");
  if (!/^wss?:\/\/\S+$/i.test(server)) throw new Error("The server address must start with wss://");
  const refreshMs = opts.refreshMs ?? 3_000;
  const streamMs = opts.streamMs ?? 570_000;
  const graceMs = opts.graceMs ?? 5_000;
  const maxFile = CAPABILITIES.maxFileBytes;

  /** Message callbacks by msgid: the req_id that replies to each, and its conversation. */
  const callbacks = new Recent<Callback>(2000);
  /** A conversation's latest message callback, and whether it is a group. */
  const latest = new Recent<string>(1000);
  const groups = new Recent<boolean>(1000);
  /** req_ids WeCom takes no more replies on. */
  const dead = new Recent<true>(2000);
  const seen = new Recent<true>(2000);
  const pressed = new Recent<true>(1000);
  /** When the bot last posted in a conversation: a message newer than that still waits for an answer. */
  const lastOut = new Recent<number>(1000);
  /** What the bot posted, so a quote of it is known as the bot's: WeCom's quote names no message. */
  const said = new Recent<{ conv: string; text: string }>(500);
  const cards = new Recent<Card>(500);
  /** Each part of a delivery once: a retry skips what already went out. */
  const posted = new Recent<string>(2000);
  const uploaded = new Recent<{ mediaId: string; at: number }>(200);
  const fetched = new Recent<Uint8Array>(16);
  const sources = new Recent<FileRef>(500);
  const streams = new Map<string, Stream>();
  const budget = new Budget(CONVERSATION, now);
  const uploads = new Budget(UPLOADS, now);

  // Messages reach the IM layer one at a time, in WeCom's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  const replyable = (msgid: string | undefined): Callback | undefined => {
    const c = msgid ? callbacks.get(msgid) : undefined;
    return c && !dead.has(c.reqId) && now() - c.at < REPLY_MS ? c : undefined;
  };

  /** A message's file, decrypted; past the size limit only its size is read. */
  const fetchFile = async (f: FileRef): Promise<{ bytes?: Uint8Array; size: number; name?: string }> => {
    const res = await n.fetch(f.url);
    if (!res.ok) throw new Error(`WeCom file download failed (${res.status})`);
    const name = fileName(res.headers.get("content-disposition"));
    const meta = name ? { name } : {};
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxFile + 32) {
      void res.body?.cancel().catch(() => {});
      return { size: Math.min(length, INBOUND_MAX), ...meta };
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    const bytes = f.aeskey ? decrypt(raw, f.aeskey) : raw;
    if (bytes.byteLength > maxFile) return { size: Math.min(bytes.byteLength, INBOUND_MAX), ...meta };
    return { bytes, size: bytes.byteLength, ...meta };
  };

  /** Files are fetched as they arrive: their addresses last five minutes, and a message may wait longer for its turn. */
  const take = async (msgid: string, files: FileRef[]): Promise<Attachment[]> => {
    const out: Attachment[] = [];
    for (const [i, f] of files.slice(0, 8).entries()) {
      const id = `${msgid}|${i}`;
      try {
        sources.set(id, f);
        const got = await fetchFile(f);
        if (got.size <= 0) continue;
        if (got.bytes) fetched.set(id, got.bytes);
        const mimeType = (got.bytes && sniff(got.bytes)) ?? mimeByName(got.name) ?? (f.type === "image" ? "image/jpeg" : f.type === "video" ? "video/mp4" : "application/octet-stream");
        const ext = extOf(mimeType);
        const name = got.name ?? `${f.type}-${i + 1}${ext ? `.${ext}` : ""}`;
        out.push({ id, name: name.slice(0, 255), mimeType: mimeType.slice(0, 128), size: got.size });
      } catch { /* a file WeCom will not hand over is left out */ }
    }
    return out;
  };

  const norm = (s: string) => plain(s).replace(/\s+/g, "").slice(0, 60);
  const oursFor = (conv: string, quote: string): string | undefined => {
    const q = norm(quote);
    if (!q) return undefined;
    for (const [id, m] of [...said].reverse()) {
      const t = norm(m.text);
      if (m.conv === conv && t && (t.startsWith(q) || q.startsWith(t))) return id;
    }
    return undefined;
  };

  const onMessage = async (m: WMessage, conv: string, group: boolean) => {
    const parsed = parseMessage(m);
    const attachments = await take(m.msgid, parsed.files);
    if (!parsed.text && !attachments.length) return;
    const quoted = m.quote ? quoteText(m.quote) : "";
    const ours = quoted ? oursFor(conv, quoted) : undefined;
    const context: ImContextMessage[] = quoted ? [{ role: "quoted", messageId: ours ?? `quote:${m.msgid}`,
      author: ours ? { id: botId, isBot: true } : { id: "unknown", isBot: false }, text: quoted.slice(0, 32_000) }] : [];
    await receive({
      kind: "message", eventId: m.msgid, messageId: m.msgid, text: parsed.text.slice(0, 32_000), activation: group ? "mention" : "dm",
      actor: { id: m.from!.userid!, isBot: false }, address: { tenantId: botId, conversationId: conv },
      ...(attachments.length ? { attachments } : {}),
      ...(ours ? { replyTo: ours } : {}),
      ...(context.length ? { context } : {})
    });
  };

  const onMessageFrame = (f: Frame<WMessage>) => {
    const m = f.body;
    const userid = m?.from?.userid;
    // `stream` asks for a refresh in callback mode; the long connection pushes its own.
    if (!m?.msgid || !userid || m.msgtype === "stream") return;
    const group = m.chattype === "group";
    const conv = group ? m.chatid : userid;
    if (!conv) return;
    // A redelivery renews the way to reply; the IM layer already has the message.
    callbacks.set(m.msgid, { reqId: f.headers.req_id, at: now(), conv });
    latest.set(conv, m.msgid);
    groups.set(conv, group);
    if (seen.has(m.msgid)) return;
    seen.set(m.msgid, true);
    later(() => onMessage(m, conv, group));
  };

  /** A card press: the card is answered at once, inside WeCom's five seconds; the IM layer hears of it after. */
  const onEventFrame = (f: Frame<WEvent>) => {
    const e = f.body;
    const ev = e?.event?.template_card_event;
    const userid = e?.from?.userid;
    if (!e?.msgid || e.event?.eventtype !== "template_card_event" || !ev || !userid || seen.has(e.msgid)) return;
    seen.set(e.msgid, true);
    const group = e.chattype === "group";
    const conv = group ? e.chatid : userid;
    if (!conv) return;
    groups.set(conv, group);
    const press = `${ev.task_id ?? ""}|${userid}`;
    const card = ev.task_id ? cards.get(ev.task_id) : undefined;
    const control = controlOf(ev, card?.control);
    if (!control || pressed.has(press)) return;
    pressed.set(press, true);
    if (card) {
      budget.take(conv);
      // In a group only the person who pressed sees it answered; the others' presses are checked by the IM layer.
      void connection.request("aibot_respond_update_msg", { response_type: "update_template_card", ...(group ? { userids: [userid] } : {}),
        template_card: answeredOf(card, control.chosen) }, f.headers.req_id).catch(() => {});
    }
    later(() => receive({ kind: "action", eventId: e.msgid, token: control.token, ...(control.value !== undefined ? { value: control.value } : {}),
      actor: { id: userid, isBot: false }, address: { tenantId: botId, conversationId: conv } }));
  };

  const connection = new LongConnection(server, { botId, secret }, n, {
    frame: f => {
      if (f.cmd === "aibot_msg_callback") onMessageFrame(f as Frame<WMessage>);
      else if (f.cmd === "aibot_event_callback") onEventFrame(f as Frame<WEvent>);
    },
    state: (state, detail) => io.status(state, detail)
  }, {
    ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.livenessMs !== undefined ? { livenessMs: opts.livenessMs } : {}),
    ...(opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}), ...(opts.ackMs !== undefined ? { ackMs: opts.ackMs } : {})
  });
  io.signal.addEventListener("abort", () => connection.stop(), { once: true });
  await connection.start();

  // ── Streams ─────────────────────────────────────────────────────────

  const alive = (s: Stream) => !s.ended && !s.over && !!s.reqId && !dead.has(s.reqId) && now() - s.startedAt < streamMs;
  const openIn = (conv: string) => {
    // A stream the IM layer never ended is long over on WeCom's side.
    for (const s of streams.values()) if (now() - s.startedAt > 2 * 3_600_000) { clearTimeout(s.timer); streams.delete(s.id); }
    return [...streams.values()].filter(s => s.conv === conv && alive(s));
  };
  /** A thinking placeholder a reply can take over; in a group only one on the same callback. */
  const placeholderOf = (conv: string, reqId: string | undefined) => openIn(conv).find(s => s.placeholder && (!groups.get(conv) || s.reqId === reqId));

  /** One stream frame: the whole text so far, which replaces what WeCom shows. */
  const frame = (s: Stream, content: string, finish: boolean) => {
    budget.take(s.conv);
    lastOut.set(s.conv, now());
    return connection.request("aibot_respond_msg", { msgtype: "stream", stream: { id: s.id, finish, content: clipBytes(content) } }, s.reqId!);
  };

  /** Whether an error means WeCom takes no more of this stream: its ten minutes are up, or its callback is. */
  const lost = (s: Stream, e: unknown): boolean => {
    if (!(e instanceof WecomError) || e.code === undefined || (e.code !== STREAM_OVER && !STALE.has(e.code))) return false;
    s.over = true;
    if (STALE.has(e.code) && s.reqId) dead.set(s.reqId, true);
    return true;
  };

  const schedule = (s: Stream, soon = false) => {
    if (s.timer || !alive(s)) return;
    s.timer = setTimeout(() => { s.timer = undefined; void refresh(s); }, soon ? 0 : Math.max(0, s.lastAt + refreshMs - now()));
  };

  /**
   * Shows a stream's latest text, at most once per `refreshMs` and only while
   * the conversation has room to spare; appends in between are folded into
   * the next refresh, and the final text always goes out when the stream ends.
   */
  const refresh = async (s: Stream) => {
    if (s.busy || !alive(s) || !s.text.trim() || s.text === s.shown) return;
    const wait = budget.wait(s.conv, 1, true);
    if (wait > 0) { s.timer = setTimeout(() => { s.timer = undefined; void refresh(s); }, wait); return; }
    s.busy = true;
    s.lastAt = now();
    const text = s.text;
    try {
      await frame(s, text, false);
      s.shown = text;
      said.set(s.id, { conv: s.conv, text });
    } catch (e) { lost(s, e); }
    finally { s.busy = false; }
    schedule(s);
  };

  // ── Sending ─────────────────────────────────────────────────────────

  /** One message: a reply on the callback's req_id where there is one, else a push; a reply WeCom no longer takes becomes a push. */
  const post = async (conv: string, reqId: string | undefined, body: Record<string, unknown>) => {
    budget.take(conv);
    lastOut.set(conv, now());
    if (reqId && !dead.has(reqId)) {
      try { await connection.request("aibot_respond_msg", body, reqId); return; }
      catch (e) { if (!(e instanceof WecomError) || e.code === undefined || !STALE.has(e.code)) throw e; dead.set(reqId, true); }
    }
    const group = groups.get(conv);
    await connection.request("aibot_send_msg", { chatid: conv, ...(group !== undefined ? { chat_type: group ? 2 : 1 } : {}), ...body });
  };

  /** A file as temporary media: init, 512 KB chunks three at a time, finish. A media id lasts three days. */
  const upload = async (key: string, bytes: Uint8Array, type: "image" | "file", name: string): Promise<string> => {
    const known = uploaded.get(key);
    if (known && now() - known.at < 2 * 86_400_000) return known.mediaId;
    uploads.take("bot");
    const total = Math.ceil(bytes.byteLength / CHUNK);
    const init = await connection.request("aibot_upload_media_init", { type, filename: clipBytes(name, 250), total_size: bytes.byteLength, total_chunks: total,
      md5: createHash("md5").update(bytes).digest("hex") });
    const uploadId = (init.body as { upload_id?: string } | undefined)?.upload_id;
    if (!uploadId) throw new WecomError("WeCom started no upload", "retryable");
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (next < total && !failed) {
        const i = next++;
        try {
          await connection.request("aibot_upload_media_chunk", { upload_id: uploadId, chunk_index: i, base64_data: Buffer.from(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)).toString("base64") });
        } catch (e) { failed = true; throw e; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
    const done = await connection.request("aibot_upload_media_finish", { upload_id: uploadId });
    const mediaId = (done.body as { media_id?: string } | undefined)?.media_id;
    if (!mediaId) throw new WecomError("WeCom gave no media id", "retryable");
    uploaded.set(key, { mediaId, at: now() });
    return mediaId;
  };

  /** Images up to 10 MB go as images, anything else up to 20 MB as a file. */
  const sendFile = async (conv: string, reqId: string | undefined, f: OutFile) => {
    const bytes = await io.readOutboundFile(f.id);
    const type = IMAGE_TYPES.has(f.mimeType) && bytes.byteLength <= IMAGE_BYTES ? "image" : "file";
    const mediaId = await upload(`${f.id}|${type}`, bytes, type, f.name);
    await post(conv, reqId, { msgtype: type, [type]: { media_id: mediaId } });
  };

  /** The text part: into `into` (a stream, which ends with it) while WeCom still takes it, else as Markdown. */
  const text = async (conv: string, reqId: string | undefined, markdown: string, key: string, into?: Stream): Promise<string> => {
    if (into && alive(into)) {
      const wasPlaceholder = into.placeholder;
      clearTimeout(into.timer);
      into.timer = undefined;
      into.ended = true;
      into.placeholder = false;
      const content = markdown || (into.shown !== THINKING ? into.shown : "") || "✓";
      try {
        await frame(into, content, true);
        into.shown = content;
        said.set(into.id, { conv, text: content });
        streams.delete(into.id);
        return into.id;
      } catch (e) {
        if (!lost(into, e)) { into.ended = false; into.placeholder = wasPlaceholder; throw e; }
      }
    }
    if (!markdown) return `none${hashOf(key)}`;
    const id = `m${hashOf(key)}`;
    await post(conv, into?.reqId ?? reqId, { msgtype: "markdown", markdown: { content: clipBytes(markdown) } });
    said.set(id, { conv, text: markdown });
    return id;
  };

  /**
   * Content as WeCom messages: its text (into `into` when given), its cards,
   * its files, each part once across retries. Replies go on `reqId` where
   * there is one, anything else is pushed. Nothing is sent unless every part
   * fits the conversation's limits now.
   */
  const send = async (operationId: string, conv: string, reqId: string | undefined, content: ImContent, into?: Stream, end = false): Promise<string> => {
    const plan = planOf(content, { taskId: i => `t${hashOf(operationId, String(i))}`, markdown: !!into });
    // WeCom takes no file under five bytes.
    const files = (content.files ?? []).filter(f => f.size >= 5);
    const steps = [...(plan.markdown || end ? ["m"] : []), ...plan.cards.map((_, i) => `c${i}`), ...files.map((_, i) => `f${i}`)];
    if (!steps.length) return `none${hashOf(operationId)}`;
    const todo = steps.filter(s => !posted.has(`${operationId}|${s}`));
    const wait = budget.wait(conv, todo.length);
    if (wait > 0) throw new WecomError("WeCom takes 30 messages a minute and 1000 an hour in one conversation", "retryable", undefined, wait);
    const fresh = files.filter((f, i) => todo.includes(`f${i}`) && !uploaded.has(`${f.id}|image`) && !uploaded.has(`${f.id}|file`)).length;
    const uploadWait = fresh ? uploads.wait("bot", fresh) : 0;
    if (uploadWait > 0) throw new WecomError("WeCom takes 30 uploads a minute and 1000 an hour", "retryable", undefined, uploadWait);
    let first: string | undefined;
    for (const step of steps) {
      const key = `${operationId}|${step}`;
      let id = posted.get(key);
      if (!id) {
        if (step === "m") id = await text(conv, reqId, plan.markdown, key, into);
        else if (step[0] === "c") {
          const card = plan.cards[Number(step.slice(1))]!;
          id = String(card.card.task_id);
          await post(conv, reqId, { msgtype: "template_card", template_card: card.card });
          cards.set(id, card);
        } else {
          id = `f${hashOf(key)}`;
          // A file needs a callback to reply on in a direct chat too: pushes are documented for Markdown and cards only.
          await sendFile(conv, reqId ?? (groups.get(conv) ? undefined : replyable(latest.get(conv))?.reqId), files[Number(step.slice(1))]!);
        }
        posted.set(key, id);
      }
      first ??= id;
    }
    return first!;
  };

  return {
    // WeCom names no bot on subscribing; the Bot ID is what it accepted.
    identity: { id: botId },

    async deliver(d) {
      const conv = d.address.conversationId;
      const anchor = replyable(d.replyTo);
      const placeholder = placeholderOf(conv, anchor?.reqId);
      // In a direct chat only the latest message's placeholder: a receipt for a newer message is not the answer to an older one.
      const into = placeholder && (groups.get(conv) || placeholder.reqId === replyable(latest.get(conv))?.reqId) ? placeholder : undefined;
      return { messageId: await send(d.operationId, conv, anchor?.reqId, d.content, into) };
    },

    async download(ref) {
      const cached = fetched.get(ref.id);
      if (cached) return cached;
      const source = sources.get(ref.id);
      if (!source) throw new Error("Attachment is not one this adapter knows");
      const got = await fetchFile(source);
      if (!got.bytes) throw new Error("Attachment is too large");
      return got.bytes;
    },

    /** A message still waiting for an answer gets a thinking placeholder, which the reply then takes over. */
    async indicate({ address, state }) {
      const conv = address.conversationId;
      if (state === "idle") {
        for (const s of openIn(conv).filter(s => s.placeholder)) {
          clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            s.timer = undefined;
            if (!s.placeholder || !alive(s)) return;
            s.ended = true;
            void frame(s, "✓", true).catch(() => {}).finally(() => streams.delete(s.id));
          }, graceMs);
        }
        return;
      }
      if (openIn(conv).length) return;
      const c = replyable(latest.get(conv));
      // Between parts of one answer the stream itself shows progress; nothing else is waiting.
      if (!c || c.at <= (lastOut.get(conv) ?? 0) || budget.wait(conv, 1, true) > 0) return;
      const s: Stream = { id: `s${randomBytes(12).toString("hex")}`, conv, reqId: c.reqId, startedAt: now(), text: "", shown: THINKING, lastAt: now(),
        placeholder: true, ended: false, over: false, busy: false };
      streams.set(s.id, s);
      try { await frame(s, THINKING, false); } catch (e) { if (!lost(s, e)) s.over = true; }
    },

    stream: {
      async start(d) {
        const conv = d.address.conversationId;
        const group = groups.get(conv) ?? false;
        const anchor = group ? replyable(d.replyTo) : replyable(latest.get(conv));
        const taken = placeholderOf(conv, anchor?.reqId);
        if (taken) {
          clearTimeout(taken.timer);
          taken.timer = undefined;
          taken.placeholder = false;
          taken.text = d.content.text;
          schedule(taken, true);
          return { messageId: taken.id };
        }
        // The id outlives the IM layer's revisions of one reply, so a retried start refreshes the stream rather than opening another.
        const id = `s${hashOf(d.operationId.replace(/:v\d+:p\d+$/, ""))}`;
        let s = streams.get(id);
        if (!s) {
          s = { id, conv, ...(anchor ? { reqId: anchor.reqId } : {}), startedAt: now(), text: "", shown: "", lastAt: now(), placeholder: false, ended: false, over: false, busy: false };
          streams.set(id, s);
        }
        s.text = d.content.text;
        // Without a callback to stream on, the text arrives whole when it ends.
        if (!alive(s)) return { messageId: id };
        const wait = budget.wait(conv, 1);
        if (wait > 0) throw new WecomError("WeCom takes 30 messages a minute and 1000 an hour in one conversation", "retryable", undefined, wait);
        try {
          await frame(s, s.text || THINKING, false);
          s.shown = s.text;
          said.set(id, { conv, text: s.text });
        } catch (e) {
          if (!lost(s, e)) throw e instanceof WecomError && e.disposition === "uncertain" ? new WecomError(e.message, "retryable", e.code) : e;
        }
        return { messageId: id };
      },

      async append({ messageId, delta }) {
        const s = streams.get(messageId);
        if (!s || s.ended) return;
        s.text += delta;
        schedule(s);
      },

      async stop({ operationId, address, messageId, content }) {
        const s = streams.get(messageId);
        if (s) { clearTimeout(s.timer); s.timer = undefined; }
        const id = await send(operationId, address.conversationId, s?.reqId, content, s, !!s);
        if (s) { s.ended = true; streams.delete(messageId); }
        return { messageId: id };
      }
    },

    close() {
      connection.stop();
      for (const s of streams.values()) clearTimeout(s.timer);
      streams.clear();
    }
  };
}
