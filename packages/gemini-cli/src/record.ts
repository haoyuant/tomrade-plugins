import fs from "node:fs";
import path from "node:path";
import type { LocalAgentRecord, LocalAgentRecordLine } from "@tomradex/plugin-sdk";
import { geminiDir } from "./lend.js";

/** How many conversation lines one read gives: the end, or the stretch before an earlier read's start. */
const PAGE = 400;
/** The most of a record read: past it only its end is, the start's lost lines read as cut. */
const RECORD_MAX = 64 * 1024 * 1024;
const LINE_TEXT = 4000;
const DETAIL_TEXT = 20_000;
const PROMPT_TITLE = 60;

/** A session id as Gemini CLI writes them: anything else could reach outside its folders. */
const SESSION_ID = /^[\w-]+$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Text that is the CLI's machinery, not the conversation: the session context it opens with, reminders. */
const isMachinery = (text: string) => /^\s*</.test(text);

interface ToolCall {
  id?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  resultDisplay?: unknown;
  status?: string;
}

interface Message {
  id: string;
  type?: string;
  content?: unknown;
  displayContent?: unknown;
  toolCalls?: ToolCall[];
}

/** Text parts as one text; a string as it is. Function calls and responses are not the conversation's words. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

/** A tool call as one quiet line: the tool, and what it ran or touched. */
function toolLine(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const what = [a.description, a.command, a.file_path, a.absolute_path, a.dir_path, a.path, a.pattern, a.url, a.query].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A call's input as a person reads it: a command as typed, an edit as removed and added lines. */
function toolInput(args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof a.command === "string") return `$ ${a.command}`;
  if (typeof a.file_path === "string" && "old_string" in a) return [a.file_path, ...text(a.old_string).split("\n").map((l) => `- ${l}`), ...text(a.new_string).split("\n").map((l) => `+ ${l}`)].join("\n");
  if (typeof a.file_path === "string" && typeof a.content === "string") return `${a.file_path}\n${a.content}`;
  return JSON.stringify(args ?? {}, null, 2);
}

/** What a call answered: its function response's output or error, else what the CLI showed for it. */
function toolOutput(call: ToolCall): string | undefined {
  const said = (Array.isArray(call.result) ? call.result : [])
    .map((p: { functionResponse?: { response?: { output?: unknown; error?: unknown } } }) => p?.functionResponse?.response)
    .map((r) => (typeof r?.output === "string" ? r.output : typeof r?.error === "string" ? r.error : r ? JSON.stringify(r) : ""))
    .filter(Boolean)
    .join("\n");
  if (said) return said;
  return typeof call.resultDisplay === "string" && call.resultDisplay ? call.resultDisplay : undefined;
}

/**
 * The conversation a Gemini CLI session file holds, replayed as the CLI loads it: messages by id (a later copy
 * replaces an earlier one in place), `$rewindTo` dropping from a message on, `$patch` updating, removing and
 * reordering, and `$set` with metadata or a whole new message list. A `.json` file is the whole record at once.
 */
export function geminiConversation(text: string, whole = false): { messages: Message[]; summary: string | null } {
  const messages = new Map<string, Message>();
  let summary: string | null = null;
  const take = (list: unknown) => {
    if (Array.isArray(list)) for (const m of list as Message[]) if (typeof m?.id === "string") messages.set(m.id, m);
  };
  const meta = (o: Record<string, unknown>) => {
    if (typeof o.summary === "string" && o.summary.trim()) summary = o.summary.trim();
  };
  const patch = (p: { id?: unknown; content?: unknown; toolCalls?: unknown }) => {
    const m = typeof p.id === "string" ? messages.get(p.id) : undefined;
    if (!m) return;
    if (p.content !== undefined) m.content = p.content;
    if (Array.isArray(p.toolCalls) && m.toolCalls) {
      for (const tp of p.toolCalls as ToolCall[]) {
        const call = m.toolCalls.find((c) => c.id === tp.id);
        if (call && "result" in tp) call.result = tp.result;
      }
    }
  };
  if (whole) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      take(o.messages);
      meta(o);
    } catch {
      // not the whole record: nothing to show
    }
    return { messages: [...messages.values()], summary };
  }
  for (const row of text.split("\n")) {
    if (!row.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(row) as Record<string, unknown>;
    } catch {
      // a line still being written, or one cut at a read's edge
      continue;
    }
    if (typeof o.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const at = ids.indexOf(o.$rewindTo);
      for (const id of at < 0 ? ids : ids.slice(at)) messages.delete(id);
    } else if (o.$patch && typeof o.$patch === "object") {
      const p = o.$patch as { id?: unknown; updates?: unknown; removeIds?: unknown; orderIds?: unknown };
      patch(p);
      if (Array.isArray(p.updates)) for (const u of p.updates) patch(u as Record<string, unknown>);
      if (Array.isArray(p.removeIds)) for (const id of p.removeIds) if (typeof id === "string") messages.delete(id);
      if (Array.isArray(p.orderIds)) {
        const ordered = (p.orderIds as unknown[]).flatMap((id) => (typeof id === "string" && messages.has(id) ? [[id, messages.get(id)!] as const] : []));
        const placed = new Set(ordered.map(([id]) => id));
        const rest = [...messages].filter(([id]) => !placed.has(id));
        messages.clear();
        for (const [id, m] of [...rest, ...ordered]) messages.set(id, m);
      }
    } else if (typeof o.id === "string") messages.set(o.id, o as unknown as Message);
    else if (o.$set && typeof o.$set === "object") {
      const set = o.$set as Record<string, unknown>;
      if (Array.isArray(set.messages)) {
        messages.clear();
        take(set.messages);
      }
      meta(set);
    } else if (typeof o.sessionId === "string") {
      take(o.messages);
      meta(o);
    }
  }
  return { messages: [...messages.values()], summary };
}

/** One message as conversation lines: what the person typed, Gemini's words, then its tool calls. */
export function geminiLines(m: Message): LocalAgentRecordLine[] {
  if (m.type === "user") {
    const text = partsText(m.displayContent ?? m.content).trim();
    return text && !isMachinery(text) ? [{ who: "person", text: clip(text, LINE_TEXT) }] : [];
  }
  if (m.type !== "gemini") return [];
  const lines: LocalAgentRecordLine[] = [];
  const text = partsText(m.content).trim();
  if (text) lines.push({ who: "agent", text: clip(text, LINE_TEXT) });
  for (const call of m.toolCalls ?? []) {
    if (!call?.name) continue;
    const output = toolOutput(call);
    lines.push({ who: "tool", text: toolLine(call.name, call.args), detail: { input: clip(toolInput(call.args), DETAIL_TEXT), ...(output !== undefined ? { output: clip(output, DETAIL_TEXT) } : {}) } });
  }
  return lines;
}

/** The record's text: all of it, or its end past `RECORD_MAX` (from a whole line). Null when it cannot be read. */
function readRecord(file: string): { text: string; cut: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - RECORD_MAX);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.subarray(0, n).toString("utf8");
    return start > 0 ? { text: text.slice(text.indexOf("\n") + 1), cut: true } : { text, cut: false };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function conversationOf(file: string): { lines: LocalAgentRecordLine[]; cut: boolean; summary: string | null } | null {
  const read = readRecord(file);
  if (!read) return null;
  const { messages, summary } = geminiConversation(read.text, file.endsWith(".json"));
  return { lines: messages.flatMap(geminiLines), cut: read.cut, summary };
}

/** The session file whose first line names this session, among a project's chats; the JSONL one over an older JSON one. */
function inChats(chats: string, sessionId: string): string | null {
  const short = sessionId.slice(0, 8);
  let names: string[];
  try {
    names = fs.readdirSync(chats);
  } catch {
    return null;
  }
  const found = names
    .filter((name) => name.startsWith("session-") && (name.endsWith(`-${short}.jsonl`) || name.endsWith(`-${short}.json`)))
    .sort((a, b) => Number(b.endsWith(".jsonl")) - Number(a.endsWith(".jsonl")) || b.localeCompare(a));
  for (const name of found) {
    const file = path.join(chats, name);
    try {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(4096);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      // An older JSON record is pretty-printed.
      if (/"sessionId":\s?"([\w-]+)"/.exec(head.subarray(0, n).toString("utf8"))?.[1] === sessionId) return file;
    } catch {
      // gone between the listing and the read
    }
  }
  return null;
}

/**
 * Where Gemini CLI keeps a session, by its id: `~/.gemini/tmp/<project>/chats/session-<time>-<first 8 of the id>.jsonl`,
 * whose first line names the whole id. The folder its `projects.json` gives the session's folder is looked in first,
 * then every project's.
 */
export function findGeminiSession(sessionId: string, cwd: string | null, dir = geminiDir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const tmp = path.join(dir, "tmp");
  const projects: string[] = [];
  if (cwd) {
    try {
      const named = (JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf8")) as { projects?: Record<string, unknown> }).projects?.[cwd];
      if (typeof named === "string" && named && !named.includes("/") && !named.includes("\\")) projects.push(named);
    } catch {
      // no project list: every project is looked in
    }
  }
  try {
    projects.push(...fs.readdirSync(tmp).filter((name) => !projects.includes(name)));
  } catch {
    return null;
  }
  for (const project of projects) {
    const file = inChats(path.join(tmp, project, "chats"), sessionId);
    if (file) return file;
  }
  return null;
}

/** What a session file calls its conversation: the summary Gemini CLI wrote, else the first thing the person asked. */
export function geminiTitle(file: string): string | null {
  const conversation = conversationOf(file);
  if (!conversation) return null;
  if (conversation.summary) return conversation.summary;
  const first = conversation.lines.find((l) => l.who === "person")?.text.replace(/\s+/g, " ").trim();
  if (!first) return null;
  return first.length > PROMPT_TITLE ? `${first.slice(0, PROMPT_TITLE - 1)}…` : first;
}

/** Gemini CLI's own record of its sessions, read and never written, so an ended one shows its conversation. */
export const geminiRecord: LocalAgentRecord = {
  find: (sessionId, opts) => findGeminiSession(sessionId, opts.cwd),
  read: (file, opts) => {
    const conversation = conversationOf(file);
    if (!conversation) return null;
    const all = conversation.lines;
    const end = Math.min(all.length, Math.max(0, opts?.before ?? all.length));
    const start = Math.max(0, end - PAGE);
    return { lines: all.slice(start, end), cut: start > 0 || conversation.cut, start };
  },
  title: geminiTitle
};
