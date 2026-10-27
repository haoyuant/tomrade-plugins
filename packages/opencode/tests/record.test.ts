import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { opencode } from "../src/opencode.js";
import { findOpencodeSession, opencodeDatabases, opencodeRecord } from "../src/record.js";

// A real OpenCode 1.19.4 session (`opencode run` asked to list a folder), its folder renamed: the rows its database holds.
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "fixtures", "ses_e82e56cf7ffevKmAVQfZNCYjNJ.json"), "utf8")) as {
  session: { id: string; project_id: string; slug: string; directory: string; title: string; version: string; time_created: number; time_updated: number };
  messages: { id: string; session_id: string; time_created: number; time_updated: number; data: string }[];
  parts: { id: string; message_id: string; session_id: string; time_created: number; time_updated: number; data: string }[];
};
const ID = FIXTURE.session.id;

/** OpenCode's tables as 1.19 creates them, the columns read here and those they cannot be without. */
function database(file: string, sessions = [FIXTURE]): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    PRAGMA journal_mode = WAL;`);
  for (const { session: s, messages, parts } of sessions) {
    db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.id, s.project_id, s.slug, s.directory, s.title, s.version, s.time_created, s.time_updated);
    for (const m of messages) db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(m.id, m.session_id, m.time_created, m.time_updated, m.data);
    for (const p of parts) db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(p.id, p.message_id, p.session_id, p.time_created, p.time_updated, p.data);
  }
  db.close();
}

const dataHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-data-"));
  fs.mkdirSync(path.join(home, "opencode"));
  return { home, dir: path.join(home, "opencode"), env: { XDG_DATA_HOME: home } as NodeJS.ProcessEnv };
};

it("declares OpenCode's own record, so its ended terminal sessions show their conversation", () => {
  expect(opencode.record).toBe(opencodeRecord);
});

it("reads a real session from OpenCode's database: the person's words, the command it ran with its output, its reply", () => {
  const { dir, env } = dataHome();
  database(path.join(dir, "opencode.db"));
  const file = findOpencodeSession(ID, env);
  expect(file).toBe(`${path.join(dir, "opencode.db")}#${ID}`);
  const read = opencodeRecord.read(file!);
  expect(read).toEqual({
    lines: [
      { who: "person", text: '"List the files in the current folder with your file listing tool (do not change anything), then reply with the word hello and the file names you saw."' },
      { who: "tool", text: "bash · ls -la", detail: { input: "$ ls -la", output: "total 8\ndrwxr-xr-x@ 3 me  wheel   96 27 Oct 19:20 .\ndrwxr-xr-x@ 9 me  wheel  288 27 Oct 19:20 ..\n-rw-r--r--@ 1 me  wheel   11 27 Oct 19:20 note.txt\n" } },
      { who: "agent", text: "hello — note.txt (only file; also `.` and `..`)" }
    ],
    cut: false,
    start: 0
  });
  expect(opencodeRecord.title?.(file!)).toBe("List current folder files and say hello");
});

it("looks in OPENCODE_DB and another channel's database too, and finds nothing it was not asked for", () => {
  const { dir, env } = dataHome();
  database(path.join(dir, "opencode-dev.db"));
  expect(findOpencodeSession(ID, env)).toBe(`${path.join(dir, "opencode-dev.db")}#${ID}`);
  const own = path.join(dir, "mine.db");
  database(own);
  expect(opencodeDatabases({ ...env, OPENCODE_DB: "mine.db" })[0]).toBe(own);
  expect(findOpencodeSession(ID, { ...env, OPENCODE_DB: "mine.db" })).toBe(`${own}#${ID}`);
  expect(findOpencodeSession("ses_missing", env)).toBeNull();
  expect(findOpencodeSession("../x", env)).toBeNull();
  expect(findOpencodeSession(ID, { XDG_DATA_HOME: path.join(dir, "nowhere") })).toBeNull();
  expect(opencodeRecord.read(`${path.join(dir, "gone.db")}#${ID}`)).toBeNull();
  expect(opencodeRecord.read(path.join(dir, "opencode-dev.db"))).toBeNull();
});

it("leaves out what is not the conversation, says a failed call's error, and keeps OpenCode's default title to itself", () => {
  const { dir, env } = dataHome();
  const at = (n: number) => 1793100256000 + n;
  const session = { ...FIXTURE.session, id: "ses_two", title: "New session - 2026-10-27T11:20:56.008Z" };
  const message = (id: string, n: number, data: object) => ({ id, session_id: "ses_two", time_created: at(n), time_updated: at(n), data: JSON.stringify(data) });
  const part = (id: string, messageId: string, data: object) => ({ id, message_id: messageId, session_id: "ses_two", time_created: 0, time_updated: 0, data: JSON.stringify(data) });
  database(path.join(dir, "opencode.db"), [{
    session,
    messages: [message("msg_1", 1, { role: "user" }), message("msg_2", 2, { role: "assistant" })],
    parts: [
      part("prt_1", "msg_1", { type: "text", text: "edit the readme" }),
      part("prt_2", "msg_1", { type: "text", text: "<system-reminder>…", synthetic: true }),
      part("prt_3", "msg_1", { type: "file", url: "file:///README.md" }),
      part("prt_4", "msg_2", { type: "reasoning", text: "Let me look." }),
      part("prt_5", "msg_2", { type: "tool", tool: "edit", state: { status: "error", input: { filePath: "README.md", oldString: "a", newString: "b" }, error: "oldString not found" } }),
      part("prt_6", "msg_2", { type: "tool", tool: "read", state: { status: "running", input: { filePath: "README.md" } } }),
      part("prt_7", "msg_2", { type: "step-finish" })
    ]
  }]);
  const file = findOpencodeSession("ses_two", env)!;
  expect(opencodeRecord.read(file)?.lines).toEqual([
    { who: "person", text: "edit the readme" },
    { who: "tool", text: "edit · README.md", detail: { input: "README.md\n- a\n+ b", output: "oldString not found" } },
    { who: "tool", text: "read · README.md", detail: { input: JSON.stringify({ filePath: "README.md" }, null, 2) } }
  ]);
  expect(opencodeRecord.title?.(file)).toBeNull();
});

it("gives a long session a stretch of messages at a time, from its end back", () => {
  const { dir, env } = dataHome();
  const messages = Array.from({ length: 250 }, (_, i) => ({ id: `msg_${String(i).padStart(3, "0")}`, session_id: "ses_long", time_created: i, time_updated: i, data: JSON.stringify({ role: i % 2 ? "assistant" : "user" }) }));
  const parts = messages.map((m, i) => ({ id: `prt_${i}`, message_id: m.id, session_id: "ses_long", time_created: i, time_updated: i, data: JSON.stringify({ type: "text", text: `said ${i}` }) }));
  database(path.join(dir, "opencode.db"), [{ session: { ...FIXTURE.session, id: "ses_long" }, messages, parts }]);
  const file = findOpencodeSession("ses_long", env)!;
  const end = opencodeRecord.read(file)!;
  expect(end).toMatchObject({ cut: true, start: 50 });
  expect(end.lines).toHaveLength(200);
  expect(end.lines[0]).toEqual({ who: "person", text: "said 50" });
  const before = opencodeRecord.read(file, { before: end.start })!;
  expect(before).toMatchObject({ cut: false, start: 0 });
  expect(before.lines.map((l) => l.text)).toEqual(Array.from({ length: 50 }, (_, i) => `said ${i}`));
});
