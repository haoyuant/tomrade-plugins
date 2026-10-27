import fs from "node:fs";
import path from "node:path";
import type { LocalAgentRecord, LocalAgentRecordLine } from "@tomradex/plugin-sdk";
import { agyDir } from "./lend.js";

/** How many conversation lines one read gives: the end, or the stretch before an earlier read's start. */
const PAGE = 400;
/** The most of a transcript read: past it only its end is. */
const RECORD_MAX = 64 * 1024 * 1024;
const LINE_TEXT = 4000;
const DETAIL_TEXT = 20_000;
const PROMPT_TITLE = 60;

/** A conversation id as agy writes them: anything else could reach outside its folders. */
const SESSION_ID = /^[\w-]+$/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Where agy keeps a conversation's compact transcript, under its app data folder. */
export const agyTranscript = (dir: string, id: string) => path.join(dir, "brain", id, ".system_generated", "logs", "transcript.jsonl");

/** What the person asked: agy wraps it in `<USER_REQUEST>`, after which come its own metadata blocks. */
export function agyRequest(text: string): string | null {
  const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(text)?.[1];
  const said = (request ?? text).trim();
  return said && (request !== undefined || !/^\s*</.test(said)) ? said : null;
}

/** A call's arguments as agy wrote them in the compact transcript: each value JSON-encoded, read back where it parses. */
function argsOf(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      try {
        return [key, JSON.parse(value) as unknown];
      } catch {
        return [key, value];
      }
    })
  );
}

/** A tool call as one quiet line: agy's own summary of it, else what it ran or touched. */
function toolLine(name: string, a: Record<string, unknown>): string {
  const what = [a.toolSummary, a.CommandLine, a.AbsolutePath, a.TargetFile, a.DirectoryPath, a.SearchPath, a.Query, a.Url, a.ToolName].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A call's input as a person reads it: a command as typed, anything else as its arguments, agy's own labels left out. */
function toolInput(a: Record<string, unknown>): string {
  if (typeof a.CommandLine === "string") return `$ ${a.CommandLine}`;
  const { toolAction: _, toolSummary: __, ...rest } = a;
  return JSON.stringify(rest, null, 2);
}

/** A step's result as agy wrote it, without the times it prefixes. */
const resultText = (step: { content?: unknown; error?: unknown }): string | undefined => {
  if (typeof step.error === "string" && step.error) return step.error;
  if (typeof step.content !== "string") return undefined;
  return step.content.replace(/^(?:Created At|Completed At): .*\n/gm, "");
};

/**
 * A transcript's steps as conversation lines: the person's requests, agy's answers and its tool calls. Each call's
 * result is a later step of the model's own (agy names no call there), taken in the order the calls were made.
 */
export function agyLines(steps: Record<string, unknown>[]): LocalAgentRecordLine[] {
  const lines: LocalAgentRecordLine[] = [];
  const waiting: LocalAgentRecordLine[] = [];
  for (const step of steps) {
    if (step.type === "USER_INPUT") {
      waiting.length = 0;
      if (step.source !== "USER_EXPLICIT" || typeof step.content !== "string") continue;
      const said = agyRequest(step.content);
      if (said) lines.push({ who: "person", text: clip(said, LINE_TEXT) });
    } else if (step.type === "PLANNER_RESPONSE") {
      waiting.length = 0;
      if (typeof step.content === "string" && step.content.trim()) lines.push({ who: "agent", text: clip(step.content.trim(), LINE_TEXT) });
      for (const call of Array.isArray(step.tool_calls) ? (step.tool_calls as { name?: unknown; args?: unknown }[]) : []) {
        if (typeof call?.name !== "string") continue;
        const args = argsOf(call.args);
        const line: LocalAgentRecordLine = { who: "tool", text: toolLine(call.name, args), detail: { input: clip(toolInput(args), DETAIL_TEXT) } };
        lines.push(line);
        waiting.push(line);
      }
    } else if (step.source === "MODEL" && waiting.length) {
      const line = waiting.shift()!;
      const output = resultText(step);
      if (output !== undefined && line.detail) line.detail.output = clip(output, DETAIL_TEXT);
    }
  }
  return lines;
}

function conversationOf(file: string): { lines: LocalAgentRecordLine[]; cut: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - RECORD_MAX);
    const buf = Buffer.alloc(size - from);
    const n = fs.readSync(fd, buf, 0, buf.length, from);
    let text = buf.subarray(0, n).toString("utf8");
    if (from > 0) text = text.slice(text.indexOf("\n") + 1);
    const steps = text.split("\n").flatMap((row) => {
      if (!row.trim()) return [];
      try {
        return [JSON.parse(row) as Record<string, unknown>];
      } catch {
        // a line still being written
        return [];
      }
    });
    return { lines: agyLines(steps), cut: from > 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The first thing the person asked in a transcript, as a title. */
export function agyTitle(file: string): string | null {
  const first = conversationOf(file)?.lines.find((l) => l.who === "person")?.text.replace(/\s+/g, " ").trim();
  if (!first) return null;
  return first.length > PROMPT_TITLE ? `${first.slice(0, PROMPT_TITLE - 1)}…` : first;
}

/** agy's own transcripts of its conversations, read and never written, so an ended one shows what was said. */
export const agyRecord: LocalAgentRecord = {
  find: (sessionId) => {
    if (!SESSION_ID.test(sessionId)) return null;
    const file = agyTranscript(agyDir(), sessionId);
    return fs.existsSync(file) ? file : null;
  },
  read: (file, opts) => {
    const conversation = conversationOf(file);
    if (!conversation) return null;
    const all = conversation.lines;
    const end = Math.min(all.length, Math.max(0, opts?.before ?? all.length));
    const start = Math.max(0, end - PAGE);
    return { lines: all.slice(start, end), cut: start > 0 || conversation.cut, start };
  },
  title: agyTitle
};
