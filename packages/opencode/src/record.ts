import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LocalAgentRecord, LocalAgentRecordLine } from "@tomradex/plugin-sdk";

/** How many of a session's messages one read gives: its last ones, or those before an earlier read's start. */
const PAGE = 200;
const LINE_TEXT = 4000;
const DETAIL_TEXT = 20_000;

/** An OpenCode session id (`ses_…`): anything else is not one of its sessions. */
const SESSION_ID = /^[\w-]+$/;
/** The title OpenCode gives a session before it names it. */
const DEFAULT_TITLE = /^(?:New session|Child session) - \d{4}-\d{2}-\d{2}T/;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Where OpenCode keeps its data: XDG_DATA_HOME/opencode, else `~/.local/share/opencode`. */
export const opencodeDataDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "opencode");

/** The databases OpenCode may keep its sessions in: OPENCODE_DB, `opencode.db`, then another channel's `opencode-<channel>.db`. */
export function opencodeDatabases(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = opencodeDataDir(env);
  const named = env.OPENCODE_DB?.trim();
  const files = named && named !== ":memory:" ? [path.isAbsolute(named) ? named : path.join(dir, named)] : [];
  files.push(path.join(dir, "opencode.db"));
  try {
    files.push(...fs.readdirSync(dir).filter((name) => /^opencode-[\w.-]+\.db$/.test(name)).sort().map((name) => path.join(dir, name)));
  } catch {
    // no data folder: nothing else to look in
  }
  return [...new Set(files)].filter((file) => fs.existsSync(file));
}

/** The SQLite Node ships, as Tomrade's runtime has it; null in one without it. */
function sqlite(): typeof import("node:sqlite") | null {
  try {
    return process.getBuiltinModule?.("node:sqlite") ?? null;
  } catch {
    return null;
  }
}

/** A database opened only to read, closed once `use` is done; null when it cannot be opened or read. */
function reading<T>(file: string, use: (db: DatabaseSync) => T): T | null {
  const sql = sqlite();
  if (!sql) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new sql.DatabaseSync(file, { readOnly: true });
    return use(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/** A record's "file": the database and the session in it. */
const recordOf = (file: string): { db: string; session: string } | null => {
  const at = file.lastIndexOf("#");
  const session = at > 0 ? file.slice(at + 1) : "";
  return SESSION_ID.test(session) ? { db: file.slice(0, at), session } : null;
};

/** A tool call as one quiet line: the tool, and what it ran or touched. */
function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const what = [i.description, i.command, i.filePath, i.path, i.pattern, i.url, i.query].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A call's input as a person reads it: a command as typed, an edit as removed and added lines. */
function toolInput(input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (typeof i.command === "string") return `$ ${i.command}`;
  if (typeof i.filePath === "string" && "oldString" in i) return [i.filePath, ...text(i.oldString).split("\n").map((l) => `- ${l}`), ...text(i.newString).split("\n").map((l) => `+ ${l}`)].join("\n");
  if (typeof i.filePath === "string" && typeof i.content === "string") return `${i.filePath}\n${i.content}`;
  return JSON.stringify(input ?? {}, null, 2);
}

interface Part {
  type?: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
}

/** One part of a message as a line: the person's words, OpenCode's, or a tool call with its output; its machinery left out. */
export function opencodeLine(role: string | undefined, part: Part): LocalAgentRecordLine | null {
  if (part.type === "text" && typeof part.text === "string" && part.text.trim() && !part.synthetic && !part.ignored) {
    if (role === "user") return { who: "person", text: clip(part.text.trim(), LINE_TEXT) };
    if (role === "assistant") return { who: "agent", text: clip(part.text.trim(), LINE_TEXT) };
  }
  if (part.type === "tool" && role === "assistant" && part.tool) {
    const state = part.state ?? {};
    const output = state.status === "error" ? state.error : state.output;
    return { who: "tool", text: toolLine(part.tool, state.input), detail: { input: clip(toolInput(state.input), DETAIL_TEXT), ...(typeof output === "string" ? { output: clip(output, DETAIL_TEXT) } : {}) } };
  }
  return null;
}

const json = (text: unknown): Record<string, unknown> => {
  try {
    return JSON.parse(String(text)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Where a session is: the first of OpenCode's databases that holds it, as `<database>#<session id>`. */
export function findOpencodeSession(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  for (const db of opencodeDatabases(env)) {
    if (reading(db, (d) => !!d.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId))) return `${db}#${sessionId}`;
  }
  return null;
}

/** A stretch of a session's conversation: its last messages, or those `before` an earlier read's start (a message's place). */
export function readOpencodeSession(file: string, opts?: { before?: number }): { lines: LocalAgentRecordLine[]; cut: boolean; start: number } | null {
  const at = recordOf(file);
  if (!at) return null;
  return reading(at.db, (db) => {
    const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(at.session) as { id: string; data: string }[];
    const end = Math.min(messages.length, Math.max(0, opts?.before ?? messages.length));
    const start = Math.max(0, end - PAGE);
    const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id");
    const lines: LocalAgentRecordLine[] = [];
    for (const message of messages.slice(start, end)) {
      const role = json(message.data).role as string | undefined;
      for (const row of parts.all(message.id) as { data: string }[]) {
        const line = opencodeLine(role, json(row.data) as Part);
        if (line) lines.push(line);
      }
    }
    return { lines, cut: start > 0, start };
  });
}

/** What OpenCode named the session; null while it has only its default title. */
export function opencodeTitle(file: string): string | null {
  const at = recordOf(file);
  if (!at) return null;
  const title = reading(at.db, (db) => (db.prepare("SELECT title FROM session WHERE id = ?").get(at.session) as { title?: unknown } | undefined)?.title);
  return typeof title === "string" && title.trim() && !DEFAULT_TITLE.test(title) ? title.trim() : null;
}

/** OpenCode's own record of its sessions (its SQLite database), read and never written, so an ended one shows its conversation. */
export const opencodeRecord: LocalAgentRecord = {
  find: (sessionId) => findOpencodeSession(sessionId),
  read: readOpencodeSession,
  title: opencodeTitle
};
