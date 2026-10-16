import { createHash, randomUUID } from "node:crypto";
import type { ImAdapter, ImAdapterSession, ImAddress, ImCapabilities, ImContent, ImContextMessage, ImDelivery, ImInbound } from "@tomradex/plugin-sdk";
import { Api, DingTalkError, net, refusesCards, type Net } from "./api.js";
import { cardText, markdownOf, paramsOf, STATUS, TEMPLATE, tokenOf } from "./card.js";
import { StreamConnection, TOPIC } from "./gateway.js";
import { addressOf, DM, fileId, parseFileId, parseMessage, Recent, targetOf, titleOf, type DCardCallback, type DMessage, type FileRef, type Target } from "./wire.js";

export const CAPABILITIES: ImCapabilities = {
  edit: true, buttons: true, inboundFiles: true, outboundFiles: true,
  // A message's parameters hold 15000 bytes; 4000 characters of Chinese stay inside them.
  maxTextLength: 4000, maxFileBytes: 20 * 1024 * 1024,
  // Groups have no threads: the first reply to a message @s the person who sent it.
  threads: false, reactions: true, typing: false, stream: "native",
  // Card buttons call back over Stream; selects, multi-selects and text entries are answered with /answer.
  select: false, multiSelect: false, textInput: false, cards: true, cardUpdate: true,
  nativeCommands: false, ephemeral: false, markdown: "dingtalk",
  // Card writes are limited per app each second; two a second per conversation stays clear of it.
  rateLimit: { messages: 20, windowMs: 10_000 }
};

type IO = Parameters<ImAdapter["open"]>[1];

const hash = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex");
/** A card's id, the same on every retry of one delivery, so a lost answer never posts it twice. */
const trackOf = (...parts: string[]) => `t${hash(...parts).slice(0, 32)}`;
const isCard = (id: string) => id.startsWith("t");

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/bmp"]);
const IMAGE_BYTES = 10 * 1024 * 1024;
/** The IM layer takes nothing larger; such a file is left out rather than lose the message. */
const MAX_INBOUND = 32 * 1024 * 1024;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
const MIME: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", mp4: "video/mp4"
};
/** DingTalk's "working on it" text emotion, as its own connector puts it on a message. */
const THINKING = { emotionId: "2659900", emotionName: "🤔思考中", text: "🤔思考中", backgroundId: "im_bg_1" };
/** A session webhook is trusted until a minute before DingTalk says it lapses. */
const WEBHOOK_MARGIN = 60_000;

function sniff(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length < 12) return undefined;
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  return at(0, 0x89, 0x50, 0x4e, 0x47) ? "image/png" : at(0, 0xff, 0xd8, 0xff) ? "image/jpeg" : at(0, 0x47, 0x49, 0x46) ? "image/gif"
    : at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) ? "image/webp" : at(0, 0x42, 0x4d) ? "image/bmp" : undefined;
}

export interface DingTalkOptions { net?: Net; backoffMs?: number; livenessMs?: number; warn?: (message: string) => void }

export async function openDingTalk(_connectionId: string, io: IO, opts: DingTalkOptions = {}): Promise<ImAdapterSession> {
  const n = opts.net ?? net();
  const clientId = io.credentials.clientId?.trim() ?? "";
  const clientSecret = io.credentials.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) throw new Error("The Client ID and Client Secret are both needed");
  // Apps made in today's console use their Client ID as the robot's code.
  const robotCode = io.credentials.robotCode?.trim() || clientId;
  const template = io.credentials.cardTemplateId?.trim() || TEMPLATE;
  const api = new Api({ clientId, clientSecret }, n);
  // A wrong secret fails here, in DingTalk's words.
  await api.accessToken();

  const webhooks = new Recent<{ url: string; until: number }>(500);
  /** DingTalk's own conversation behind each message a person sent, which text emotions name. */
  const conversations = new Recent<string>(1000);
  /** Who sent each message, so the first reply to it in a group can @ them. */
  const senders = new Recent<{ id: string; nick?: string }>(1000);
  const mentioned = new Recent<true>(500);
  const seen = new Recent<true>(1000);
  const tenants = new Recent<string>(500);
  /** Where each card this session posted lives, so a button pressed on it finds its conversation. */
  const cards = new Recent<ImAddress>(1000);
  const tried = new Recent<true>(500);
  /** Each part of a delivery once: a retry after a partial failure skips what already went. */
  const sent = new Recent<string>(1000);
  /** Whether each message carries the thinking emotion, once the reaction before has run. */
  const thinking = new Recent<Promise<boolean>>(1000);
  const refs = new Recent<FileRef>(200);
  const fetched = new Recent<Uint8Array>(16);
  const streams = new Map<string, { text: string }>();
  let cardsOn = true;

  // Messages reach the IM layer one at a time, in DingTalk's order.
  let queue = Promise.resolve();
  const later = (work: () => Promise<unknown>) => { queue = queue.then(work).then(() => {}, () => {}); };
  const receive = (event: ImInbound) => io.receive(event).catch(() => {});

  const fetchRef = async (f: FileRef, probe: boolean) => api.fetchFile(await api.downloadUrl(f.code, robotCode), { probe });

  /** Sizes and types for a message's files; images are fetched whole, since their headers rarely say what they are. */
  const probe = async (files: FileRef[]) => {
    const out: NonNullable<(ImInbound & { kind: "message" })["attachments"]> = [];
    for (const [i, f] of files.slice(0, 8).entries()) {
      try {
        let id = fileId(f);
        if (id.length > 256) { id = `${f.kind === "image" ? "i" : "f"}#${hash(f.code).slice(0, 32)}`; refs.set(id, f); }
        const got = await fetchRef(f, f.kind === "file");
        if (got.bytes) fetched.set(id, got.bytes);
        if (got.size <= 0 || got.size > MAX_INBOUND) continue;
        const typed = got.mimeType && got.mimeType !== "application/octet-stream" ? got.mimeType : undefined;
        const mimeType = typed ?? sniff(got.bytes) ?? MIME[f.name?.split(".").pop()?.toLowerCase() ?? ""] ?? (f.kind === "image" ? "image/jpeg" : "application/octet-stream");
        const name = f.name ?? (f.kind === "image" ? `image-${i + 1}.${EXT[mimeType] ?? "jpg"}` : `file-${i + 1}`);
        out.push({ id, name: name.slice(0, 255), mimeType: mimeType.slice(0, 128), size: got.size });
      } catch { /* a file DingTalk will not hand over is left out */ }
    }
    return out;
  };

  const onMessage = async (m: DMessage) => {
    const actorId = m.senderStaffId || m.senderId;
    if (!m.msgId || !actorId || !m.conversationId || seen.has(m.msgId)) return;
    seen.set(m.msgId, true);
    const address = addressOf(m);
    tenants.set(address.conversationId, address.tenantId);
    conversations.set(m.msgId, m.conversationId);
    senders.set(m.msgId, { id: actorId, ...(m.senderNick ? { nick: m.senderNick } : {}) });
    if (m.sessionWebhook) webhooks.set(address.conversationId, { url: m.sessionWebhook, until: Number(m.sessionWebhookExpiredTime) || Date.now() + 5 * 60_000 });
    const parsed = parseMessage(m);
    const q = parsed.quoted;
    const quotesBot = !!q?.senderId && q.senderId === m.chatbotUserId;
    // DingTalk hands a robot only the group messages that @ it.
    const activation = m.conversationType !== "2" ? "dm" : m.isInAtList === false ? (quotesBot ? "reply" : "ambient") : "mention";
    if (activation === "ambient" && !parsed.text) return;
    const attachments = activation === "ambient" ? [] : await probe(parsed.files);
    if (!parsed.text && !attachments.length) return;
    const context: ImContextMessage[] = q?.text ? [{ role: "quoted", messageId: q.messageId, author: { id: q.senderId ?? "unknown", isBot: quotesBot }, text: q.text }] : [];
    await receive({
      kind: "message", eventId: m.msgId, messageId: m.msgId, text: parsed.text, activation,
      actor: { id: actorId, ...(m.senderNick ? { name: m.senderNick } : {}), isBot: false }, address,
      ...(attachments.length ? { attachments } : {}),
      ...(q ? { replyTo: q.messageId } : {}),
      ...(context.length ? { context } : {})
    });
  };

  /** A card from before a restart: a direct chat is the presser's own; a group is the card's space. */
  const placeOf = (cb: DCardCallback): ImAddress | undefined => {
    const conversationId = /ROBOT/i.test(cb.spaceType ?? "") ? `${DM}${cb.userId}` : cb.spaceId?.startsWith("cid") ? cb.spaceId : undefined;
    return conversationId ? { tenantId: tenants.get(conversationId) ?? cb.corpId ?? "dingtalk", conversationId } : undefined;
  };

  /** Answered at once, inside DingTalk's three seconds; the outcome updates the card later. */
  const onAction = (cb: DCardCallback, frameId: string) => {
    const token = tokenOf(cb.content);
    const address = cb.outTrackId ? cards.get(cb.outTrackId) ?? placeOf(cb) : undefined;
    if (!token || !cb.userId || !address) return {};
    const actor = cb.userId;
    later(() => receive({ kind: "action", eventId: `card:${frameId || `${cb.outTrackId}:${token}`}`, token, actor: { id: actor, isBot: false }, address }));
    return {};
  };

  const connection = new StreamConnection(api, n, {
    callback: (topic, data, frameId) => {
      if (topic === TOPIC.card) return onAction(data as DCardCallback, frameId);
      if (topic === TOPIC.message) later(() => onMessage(data as DMessage));
      return null;
    },
    state: (state, detail) => io.status(state, detail)
  }, { ...(opts.backoffMs !== undefined ? { backoffMs: opts.backoffMs } : {}), ...(opts.livenessMs !== undefined ? { livenessMs: opts.livenessMs } : {}) });
  io.signal.addEventListener("abort", () => connection.stop(), { once: true });
  await connection.start();

  const once = async (operationId: string, part: string, work: () => Promise<string>) => {
    const key = `${operationId}\u0000${part}`;
    const done = sent.get(key);
    if (done) return done;
    const id = await work();
    sent.set(key, id);
    return id;
  };

  /** The person a group reply should @: who sent the message it answers, once per message. */
  const atOf = (d: ImDelivery) => (d.replyTo && !targetOf(d.address).dm && !mentioned.has(d.replyTo) ? senders.get(d.replyTo) : undefined);

  const space = (t: Target, at?: { id: string; nick?: string }) => t.dm
    ? { openSpaceId: `dtv1.card//IM_ROBOT.${t.userId}`, imRobotOpenSpaceModel: { supportForward: true }, imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode } }
    : { openSpaceId: `dtv1.card//IM_GROUP.${t.group}`, imGroupOpenSpaceModel: { supportForward: true },
      imGroupOpenDeliverModel: { robotCode, ...(at ? { atUserIds: { [at.id]: at.nick ?? at.id } } : {}) } };

  const updateCard = (id: string, params: Record<string, string>) =>
    api.call("PUT", "/v1.0/card/instances", { outTrackId: id, cardData: { cardParamMap: params }, cardUpdateOptions: { updateCardDataByKey: true } });

  /** The whole text each time: a lost update only delays what the card shows. */
  const streamCard = (id: string, markdown: string, finalize: boolean) =>
    api.call("PUT", "/v1.0/card/streaming", { outTrackId: id, guid: randomUUID(), key: "msgContent", content: markdown, isFull: true, isFinalize: finalize, isError: false });

  const postCard = async (d: ImDelivery, params: Record<string, string>, part: string): Promise<string> => {
    const id = trackOf(d.operationId, part);
    const at = atOf(d);
    const retry = tried.has(id);
    tried.set(id, true);
    try {
      const r = await api.call<{ result?: { deliverResults?: { success?: boolean; errorMsg?: string }[] } }>("POST", "/v1.0/card/instances/createAndDeliver", {
        cardTemplateId: template, outTrackId: id, callbackType: "STREAM", userIdType: 1, cardData: { cardParamMap: params }, ...space(targetOf(d.address), at)
      });
      const failed = r.result?.deliverResults?.find(x => x.success === false);
      if (failed) throw new DingTalkError(`DingTalk did not deliver the card${failed.errorMsg ? `: ${failed.errorMsg}` : ""}`, "permanent");
    } catch (e) {
      // An earlier try whose answer was lost made the card; writing it is all that is left.
      if (!retry || !(e instanceof DingTalkError) || e.disposition !== "permanent" || refusesCards(e)) throw e;
      await updateCard(id, params).catch(() => { throw e; });
    }
    cards.set(id, d.address);
    if (at) mentioned.set(d.replyTo!, true);
    return id;
  };

  /** A message through the robot's own API, which reaches a conversation whenever DingTalk lets the robot in. */
  const robotSend = async (t: Target, msgKey: string, param: Record<string, string>): Promise<string> => {
    const body = { robotCode, msgKey, msgParam: JSON.stringify(param) };
    if (t.dm) {
      const r = await api.call<{ processQueryKey?: string; invalidStaffIdList?: string[]; flowControlledStaffIdList?: string[] }>("POST", "/v1.0/robot/oToMessages/batchSend", { ...body, userIds: [t.userId] }, false);
      if (r.flowControlledStaffIdList?.length) throw new DingTalkError("DingTalk rate limit (flow control)", "retryable", "flowControlled", 60_000);
      if (r.invalidStaffIdList?.length) throw new DingTalkError(`DingTalk does not know the user ${t.userId}`, "permanent", "invalidStaffId");
      return `m${r.processQueryKey ?? randomUUID()}`;
    }
    const r = await api.call<{ processQueryKey?: string }>("POST", "/v1.0/robot/groupMessages/send", { ...body, openConversationId: t.group }, false);
    return `m${r.processQueryKey ?? randomUUID()}`;
  };

  /** A Markdown message: through the session webhook while it lasts, else through the robot's API. */
  const postMarkdown = async (d: ImDelivery, markdown: string): Promise<string> => {
    const title = titleOf(markdown);
    const hook = webhooks.get(d.address.conversationId);
    if (hook && hook.until - WEBHOOK_MARGIN > Date.now()) {
      const at = atOf(d);
      const r = await api.webhook(hook.url, { msgtype: "markdown", markdown: { title, text: at ? `${markdown}\n\n@${at.id}` : markdown }, ...(at ? { at: { atUserIds: [at.id] } } : {}) });
      if (r.ok) {
        if (at) mentioned.set(d.replyTo!, true);
        return `m${hash(d.operationId).slice(0, 32)}`;
      }
      // Lapsed or refused: the robot's API reaches the same conversation.
      webhooks.delete(d.address.conversationId);
    }
    return robotSend(targetOf(d.address), "sampleMarkdown", { title, text: markdown });
  };

  const cardsOff = (e: unknown) => {
    cardsOn = false;
    opts.warn?.(`DingTalk cards are unavailable, so replies go as Markdown messages without buttons or streaming (${(e as Error).message}). Grant the app Card.Instance.Write and Card.Streaming.Write, or check the card template ID.`);
  };

  /** A card while DingTalk takes them; once it refuses, Markdown for the rest of the session. */
  const post = (d: ImDelivery) => once(d.operationId, "body", async () => {
    if (cardsOn) {
      try { return await postCard(d, paramsOf(d.content, STATUS.finished, "staticMsgContent"), "body"); }
      catch (e) { if (!refusesCards(e)) throw e; cardsOff(e); }
    }
    return postMarkdown(d, markdownOf(d.content));
  });

  const sendFile = (d: ImDelivery, f: NonNullable<ImContent["files"]>[number], i: number) => once(d.operationId, `f${i}`, async () => {
    const bytes = await io.readOutboundFile(f.id);
    const image = IMAGE_TYPES.has(f.mimeType) && bytes.byteLength <= IMAGE_BYTES;
    const mediaId = await api.upload(image ? "image" : "file", f.name, f.mimeType, bytes);
    const ext = f.name.includes(".") ? f.name.split(".").pop()!.toLowerCase() : "file";
    return robotSend(targetOf(d.address), image ? "sampleImageMsg" : "sampleFile", image ? { photoURL: mediaId } : { mediaId, fileName: f.name, fileType: ext });
  });

  return {
    identity: { id: robotCode },

    async deliver(d: ImDelivery) {
      if (d.replaceMessageId) {
        // A Markdown message cannot change; its first version stands.
        if (isCard(d.replaceMessageId)) await updateCard(d.replaceMessageId, paramsOf(d.content, STATUS.finished, "staticMsgContent"));
        return { messageId: d.replaceMessageId };
      }
      const files = d.content.files ?? [];
      let first: string | undefined;
      if (d.content.text || d.content.actions?.length || d.content.elements?.length || !files.length) first = await post(d);
      for (const [i, f] of files.entries()) {
        try {
          const id = await sendFile(d, f, i);
          first ??= id;
        } catch (e) {
          // A file type DingTalk will not store: the message above already names it.
          if (!first || !(e instanceof DingTalkError) || e.disposition !== "permanent") throw e;
          opts.warn?.(`DingTalk did not take ${f.name}: ${e.message}`);
        }
      }
      return { messageId: first! };
    },

    async download(ref) {
      const cached = fetched.get(ref.id);
      if (cached) return cached;
      const f = refs.get(ref.id) ?? parseFileId(ref.id);
      if (!f) throw new Error("Attachment is not one this adapter knows");
      return (await fetchRef(f, false)).bytes!;
    },

    async react({ messageId, reaction }) {
      const conversation = conversations.get(messageId);
      if (!conversation) return;
      // "Received" puts DingTalk's thinking emotion on the message; the outcome takes it away, the reply itself says how it went.
      // One message's reactions run in order: a quick turn's outcome must not overtake the emotion it removes.
      const before = thinking.get(messageId) ?? Promise.resolve(false);
      const want = reaction === "received";
      const step = before.then(async on => {
        if (on === want) return on;
        await api.call("POST", `/v1.0/robot/emotion/${want ? "reply" : "recall"}`, {
          robotCode, openMsgId: messageId, openConversationId: conversation, emotionType: 2, emotionName: THINKING.emotionName, textEmotion: THINKING
        });
        return want;
      });
      thinking.set(messageId, step.catch(() => before));
      await step;
    },

    stream: {
      async start(d) {
        if (cardsOn) {
          try {
            const id = await once(d.operationId, "stream", () => postCard(d, paramsOf({ text: d.content.text }, STATUS.inputting, "msgContent"), "stream"));
            streams.set(id, { text: d.content.text });
            return { messageId: id };
          } catch (e) { if (!refusesCards(e)) throw e; cardsOff(e); }
        }
        // Without cards nothing grows in place: the reply is posted once it settles.
        return { messageId: `s${hash(d.operationId).slice(0, 32)}` };
      },

      async append({ messageId, delta }) {
        const s = streams.get(messageId);
        if (!s) return;
        s.text += delta;
        await streamCard(messageId, cardText({ text: s.text }), false);
      },

      async stop({ operationId, address, messageId, content }) {
        streams.delete(messageId);
        if (!isCard(messageId)) return { messageId: await once(operationId, "settle", () => postMarkdown({ operationId, address, content }, markdownOf(content))) };
        const params = paramsOf(content, STATUS.finished, "msgContent");
        await streamCard(messageId, params.msgContent!, true).catch(() => null);
        await updateCard(messageId, params);
        return { messageId };
      }
    },

    close() {
      connection.stop();
      streams.clear();
    }
  };
}
