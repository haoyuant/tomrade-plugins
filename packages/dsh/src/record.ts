import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { LocalAgentRecord, LocalAgentRecordLine } from "@tomradex/plugin-sdk";

/** How many conversation lines one read gives: the end, or the stretch before an earlier read's start. */
const PAGE = 400;
/** The most of a session log taken in, compressed or as written: past it nothing is read. */
const RECORD_MAX = 256 * 1024 * 1024;
const LINE_TEXT = 4000;
const DETAIL_TEXT = 20_000;
const PROMPT_TITLE = 60;

/** A session id as dsh writes them (`<uuid>` or `session-<uuid>`): anything else could reach outside its folders. */
const SESSION_ID = /^[\w-]+$/;
/** The log of one session in its folder, newest format first; dsh compresses it with Zstandard unless told not to. */
const LOGS = ["session.v4.jsonl.zstd", "session.jsonl.zstd", "session.v4.jsonl", "session.jsonl"];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const isMachinery = (text: string) => /^\s*</.test(text);

/** Where dsh keeps its sessions: `$DSH_HOME/sessions`, else `~/.dsh/sessions`, a folder per working folder. */
export const dshSessionsDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh"), "sessions");

/** Where one Zstandard frame that starts at `at` ends; null for a frame cut short (still being written) or not one. */
function frameEnd(buf: Buffer, at: number): number | null {
  if (at + 8 > buf.length) return null;
  const magic = buf.readUInt32LE(at);
  // A skippable frame: its size follows.
  if ((magic & 0xfffffff0) === 0x184d2a50) return at + 8 + buf.readUInt32LE(at + 4);
  if (magic !== 0xfd2fb528) return null;
  const descriptor = buf[at + 4]!;
  const single = (descriptor >> 5) & 1;
  let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]! + [single, 2, 4, 8][descriptor >> 6]!;
  for (;;) {
    if (p + 3 > buf.length) return null;
    const header = buf[p]! | (buf[p + 1]! << 8) | (buf[p + 2]! << 16);
    const type = (header >> 1) & 3;
    if (type === 3) return null;
    // A run-length block holds one byte, whatever size it stands for.
    p += 3 + (type === 1 ? 1 : header >>> 3);
    if (header & 1) break;
  }
  p += (descriptor >> 2) & 1 ? 4 : 0;
  return p <= buf.length ? p : null;
}

/**
 * A session log as text: dsh appends each event as a Zstandard frame of its own, and Node's decompressor stops at the
 * first, so the frames are taken one by one. Null where the runtime has no Zstandard (older than Node 22.15).
 */
export function dshLogText(buf: Buffer, compressed: boolean): string | null {
  if (!compressed) return buf.toString("utf8");
  const zstd = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!zstd) return null;
  const out: Buffer[] = [];
  let at = 0;
  while (at < buf.length) {
    const end = frameEnd(buf, at);
    if (end === null) break;
    if (buf.readUInt32LE(at) === 0xfd2fb528) out.push(zstd(buf.subarray(at, end)));
    at = end;
  }
  return Buffer.concat(out).toString("utf8");
}

/** A tool call as one quiet line: the tool, and what it ran or touched. */
function toolLine(name: string, input: Record<string, unknown>): string {
  const what = [input.description, input.command, input.file_path, input.path, input.pattern, input.url, input.query].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A call's input as a person reads it: a command as typed, an edit as removed and added lines. */
function toolInput(input: Record<string, unknown>, raw: string): string {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof input.command === "string") return `$ ${input.command}`;
  if (typeof input.file_path === "string" && "old_string" in input) return [input.file_path, ...text(input.old_string).split("\n").map((l) => `- ${l}`), ...text(input.new_string).split("\n").map((l) => `+ ${l}`)].join("\n");
  if (typeof input.file_path === "string" && typeof input.content === "string") return `${input.file_path}\n${input.content}`;
  return Object.keys(input).length ? JSON.stringify(input, null, 2) : raw;
}

const blocksText = (content: unknown): string =>
  Array.isArray(content) ? content.map((b: { type?: string; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).filter(Boolean).join("\n") : "";

/**
 * A session log's events as conversation lines: what the person said (not the runtime context, skill catalog or
 * instructions dsh adds as user messages), dsh's words and tool calls, each call's result filed under it.
 */
export function dshLines(events: Record<string, unknown>[]): { lines: LocalAgentRecordLine[]; title: string | null } {
  const lines: LocalAgentRecordLine[] = [];
  const calls = new Map<string, LocalAgentRecordLine>();
  let title: string | null = null;
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, any>;
    if (event.type === "user/message" && data.source?.kind === "user") {
      const text = blocksText(data.content).trim();
      if (text && !isMachinery(text)) lines.push({ who: "person", text: clip(text, LINE_TEXT) });
    } else if (event.type === "assistant/message") {
      for (const block of Array.isArray(data.message?.content) ? data.message.content : []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) lines.push({ who: "agent", text: clip(block.text.trim(), LINE_TEXT) });
        else if (block?.type === "tool-call" && typeof block.name === "string") {
          const raw = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
          let input: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          } catch {
            // arguments that are not JSON are shown as written
          }
          const line: LocalAgentRecordLine = { who: "tool", text: toolLine(block.name, input), detail: { input: clip(toolInput(input, raw), DETAIL_TEXT) } };
          lines.push(line);
          if (typeof block.id === "string") calls.set(block.id, line);
        }
      }
    } else if (event.type === "tool/result") {
      const line = typeof data.message?.toolCallId === "string" ? calls.get(data.message.toolCallId) : undefined;
      if (line?.detail) line.detail.output = clip(blocksText(data.message.content), DETAIL_TEXT);
    } else if (event.type === "session/title" && typeof data.title === "string" && data.title.trim()) title = data.title.trim();
  }
  return { lines, title };
}

function conversationOf(file: string): { lines: LocalAgentRecordLine[]; title: string | null } | null {
  try {
    if (fs.statSync(file).size > RECORD_MAX) return null;
    const text = dshLogText(fs.readFileSync(file), file.endsWith(".zstd"));
    if (text === null) return null;
    const events = text.split("\n").flatMap((row) => {
      if (!row.trim()) return [];
      try {
        return [JSON.parse(row) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    return dshLines(events);
  } catch {
    return null;
  }
}

/** Where dsh keeps a session's log, by its id, in whichever working folder's sessions it ran: `<id>/session.v4.jsonl.zstd`. */
export function findDshSession(sessionId: string, dir = dshSessionsDir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  // Older sessions are named `session-<uuid>`; a bare id may be either.
  const names = sessionId.startsWith("session-") ? [sessionId] : [sessionId, `session-${sessionId}`];
  let folders: string[];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const folder of folders) {
    for (const name of names) {
      for (const log of LOGS) {
        const file = path.join(dir, folder, name, log);
        if (fs.existsSync(file)) return file;
      }
    }
  }
  return null;
}

/** dsh's own record of its sessions, read and never written, so an ended one shows its conversation. */
export const dshRecord: LocalAgentRecord = {
  find: (sessionId) => findDshSession(sessionId),
  read: (file, opts) => {
    const conversation = conversationOf(file);
    if (!conversation) return null;
    const all = conversation.lines;
    const end = Math.min(all.length, Math.max(0, opts?.before ?? all.length));
    const start = Math.max(0, end - PAGE);
    return { lines: all.slice(start, end), cut: start > 0, start };
  },
  // The title dsh gave the session, else the first thing the person asked.
  title: (file) => {
    const conversation = conversationOf(file);
    if (!conversation) return null;
    if (conversation.title) return conversation.title;
    const first = conversation.lines.find((l) => l.who === "person")?.text.replace(/\s+/g, " ").trim();
    if (!first) return null;
    return first.length > PROMPT_TITLE ? `${first.slice(0, PROMPT_TITLE - 1)}…` : first;
  }
};
