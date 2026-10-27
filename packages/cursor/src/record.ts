import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LocalAgentRecord, LocalAgentRecordLine } from "@tomradex/plugin-sdk";

/** How much of a transcript one read takes, from its end or before an earlier read's start. */
const PAGE = 2 * 1024 * 1024;
/** How much of a transcript's head is read for its first prompt. */
const TITLE_CHUNK = 256 * 1024;
const LINE_TEXT = 4000;
const DETAIL_TEXT = 20_000;
const PROMPT_TITLE = 60;

/** A conversation id as Cursor writes them: anything else could reach outside its folders. */
const SESSION_ID = /^[\w-]+$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Bytes of an open file, from `start`. */
function readAt(fd: number, start: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
}

/** Where the line holding byte `pos` begins: just after the newline before it. */
function lineStart(fd: number, pos: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  let end = pos;
  while (end > 0) {
    const from = Math.max(0, end - chunk.length);
    const n = fs.readSync(fd, chunk, 0, end - from, from);
    const at = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (at >= 0) return from + at + 1;
    end = from;
  }
  return 0;
}

const entriesOf = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((row) => {
    if (!row.trim()) return [];
    try {
      return [JSON.parse(row) as Record<string, unknown>];
    } catch {
      // a line still being written
      return [];
    }
  });

/**
 * What the person typed: Cursor wraps a prompt in `<user_query>` after a `<timestamp>` and other context, which is
 * its machinery. Text with no query in it is the person's only when it does not open with such a tag.
 */
export function cursorPrompt(text: string): string | null {
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text)?.[1];
  const said = (query ?? text).trim();
  return said && (query !== undefined || !/^\s*</.test(said)) ? said : null;
}

/** A tool call as one quiet line: the tool, and what it ran or touched. */
function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const what = [i.description, i.command, i.path, i.file_path, i.pattern, i.globPattern, i.url, i.query, i.toolName].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A call's input as a person reads it: a command as typed, an edit as removed and added lines. */
function toolInput(input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof i.command === "string") return `$ ${i.command}`;
  if (typeof i.path === "string" && "old_string" in i) return [i.path, ...text(i.old_string).split("\n").map((l) => `- ${l}`), ...text(i.new_string).split("\n").map((l) => `+ ${l}`)].join("\n");
  if (typeof i.path === "string" && typeof i.contents === "string") return `${i.path}\n${i.contents}`;
  return JSON.stringify(input ?? {}, null, 2);
}

/** One entry of a Cursor transcript as conversation lines; Cursor writes no tool results there. */
export function cursorLines(o: Record<string, unknown>): LocalAgentRecordLine[] {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content) || (o.role !== "user" && o.role !== "assistant")) return [];
  return content.flatMap((b: { type?: string; text?: unknown; name?: unknown; input?: unknown }): LocalAgentRecordLine[] => {
    if (b.type === "text" && typeof b.text === "string") {
      if (o.role === "assistant") return b.text.trim() ? [{ who: "agent", text: clip(b.text.trim(), LINE_TEXT) }] : [];
      const said = cursorPrompt(b.text);
      return said ? [{ who: "person", text: clip(said, LINE_TEXT) }] : [];
    }
    if (b.type === "tool_use" && o.role === "assistant" && typeof b.name === "string") return [{ who: "tool", text: toolLine(b.name, b.input), detail: { input: clip(toolInput(b.input), DETAIL_TEXT) } }];
    return [];
  });
}

/**
 * Where cursor-agent keeps a conversation's transcript, by its id: `~/.cursor/projects/<folder>/agent-transcripts/<id>/<id>.jsonl`
 * (`<id>.jsonl` straight under agent-transcripts in older versions), the folder named after the one it ran in.
 */
export function findCursorTranscript(sessionId: string, home = os.homedir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const projects = path.join(home, ".cursor", "projects");
  let names: string[];
  try {
    names = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = path.join(projects, name, "agent-transcripts");
    for (const file of [path.join(dir, sessionId, `${sessionId}.jsonl`), path.join(dir, `${sessionId}.jsonl`)]) if (fs.existsSync(file)) return file;
  }
  return null;
}

/** A stretch of a transcript as conversation lines: its end, or what came `before` an earlier read's start, in whole lines. */
export function readCursorTranscript(file: string, opts?: { before?: number }): { lines: LocalAgentRecordLine[]; cut: boolean; start: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const end = Math.min(size, Math.max(0, opts?.before ?? size));
    const start = end > 0 ? lineStart(fd, Math.max(0, end - PAGE)) : 0;
    return { lines: entriesOf(readAt(fd, start, end - start)).flatMap(cursorLines), cut: start > 0, start };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The first thing the person asked in a transcript, as a title. */
export function cursorTitle(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    for (const entry of entriesOf(readAt(fd, 0, TITLE_CHUNK))) {
      const first = cursorLines(entry).find((l) => l.who === "person")?.text.replace(/\s+/g, " ").trim();
      if (first) return first.length > PROMPT_TITLE ? `${first.slice(0, PROMPT_TITLE - 1)}…` : first;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** cursor-agent's own transcripts of its conversations, read and never written, so an ended one shows what was said. */
export const cursorRecord: LocalAgentRecord = {
  find: (sessionId) => findCursorTranscript(sessionId),
  read: readCursorTranscript,
  title: cursorTitle
};
