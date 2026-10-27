import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { gemini } from "../src/gemini.js";
import { findGeminiSession, geminiRecord, geminiTitle } from "../src/record.js";

// A real Gemini CLI 0.65 session (`gemini -p` asked to list a folder), its paths and session context shortened.
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "session-2026-10-27T11-20-7162754a.jsonl");
const ID = "7162754a-ec86-45f8-885f-a9c0f9d81105";

/** A Gemini home with one project whose chats hold `files`. */
function home(files: Record<string, string>, project = "demo", cwd = "/home/me/demo"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-record-"));
  const chats = path.join(dir, "tmp", project, "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.mkdirSync(path.join(dir, "tmp", "other", "chats"), { recursive: true });
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects: { [cwd]: project } }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(chats, name), text);
  return dir;
}

const rows = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

it("declares Gemini CLI's own record, so its ended terminal sessions show their conversation", () => {
  expect(gemini.record).toBe(geminiRecord);
});

it("reads a real session: the person's words, the tool call with its answer, Gemini's reply; not the session context", () => {
  const read = geminiRecord.read(FIXTURE);
  expect(read).toEqual({
    lines: [
      { who: "person", text: "Use your tool for listing a directory on the current folder, then reply with the word hello and the file names you saw." },
      { who: "tool", text: "list_directory · .", detail: { input: JSON.stringify({ dir_path: "." }, null, 2), output: "Directory listing for /home/me/demo:\nnote.txt (11 bytes)" } },
      { who: "agent", text: "Hello, note.txt" }
    ],
    cut: false,
    start: 0
  });
  // No summary written yet: the first thing asked names it.
  expect(geminiTitle(FIXTURE)).toBe("Use your tool for listing a directory on the current folder…");
});

it("finds a session by its whole id, in the folder's own project first, and not one that only shares its first 8", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  const dir = home({ "session-2026-10-27T11-20-7162754a.jsonl": text });
  const file = path.join(dir, "tmp", "demo", "chats", "session-2026-10-27T11-20-7162754a.jsonl");
  expect(findGeminiSession(ID, "/home/me/demo", dir)).toBe(file);
  // Without the folder, or with one projects.json does not know, every project is looked in.
  expect(findGeminiSession(ID, null, dir)).toBe(file);
  expect(findGeminiSession(ID, "/elsewhere", dir)).toBe(file);
  expect(findGeminiSession("7162754a-0000-0000-0000-000000000000", null, dir)).toBeNull();
  expect(findGeminiSession("../../etc", null, dir)).toBeNull();
  expect(findGeminiSession(ID, null, path.join(dir, "nowhere"))).toBeNull();
  // Resuming an older JSON record writes a JSONL one beside it, which is the one read.
  fs.writeFileSync(path.join(dir, "tmp", "demo", "chats", "session-2026-10-26T09-00-7162754a.json"), JSON.stringify({ sessionId: ID, messages: [] }, null, 2));
  expect(findGeminiSession(ID, null, dir)).toBe(file);
});

it("replays the record as Gemini CLI loads it: replaced messages, patches, rewinds, a new list, and its summary as the title", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-replay-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    file,
    rows(
      { sessionId: "s1", projectHash: "h", kind: "main" },
      { id: "u1", type: "user", content: [{ text: "first try" }] },
      { id: "g1", type: "gemini", content: "thinking it over" },
      { $rewindTo: "u1" },
      { id: "u2", type: "user", content: "fix the build", displayContent: [{ text: "fix the build @package.json" }] },
      { id: "g2", type: "gemini", content: "", toolCalls: [{ id: "c1", name: "run_shell_command", args: { command: "pnpm build", description: "Build it" } }] },
      { $patch: { id: "g2", toolCalls: [{ id: "c1", result: [{ functionResponse: { id: "c1", name: "run_shell_command", response: { error: "exit 1" } } }] }] } },
      { id: "i1", type: "info", content: "Switched to fallback model." },
      { id: "g3", type: "gemini", content: [{ text: "It fails at " }, { text: "the type check." }], toolCalls: [{ id: "c2", name: "replace", args: { file_path: "a.ts", old_string: "x", new_string: "y" }, resultDisplay: "Edited a.ts" }] },
      { $patch: { updates: [{ id: "g3", content: "Fixed." }], removeIds: ["i1"] } },
      { $set: { summary: "Fix the build" } },
      "half a line"
    ).slice(0, -1) + '{"id":"g4","type":"gem'
  );
  expect(geminiRecord.read(file)?.lines).toEqual([
    { who: "person", text: "fix the build @package.json" },
    { who: "tool", text: "run_shell_command · Build it", detail: { input: "$ pnpm build", output: "exit 1" } },
    { who: "agent", text: "Fixed." },
    { who: "tool", text: "replace · a.ts", detail: { input: "a.ts\n- x\n+ y", output: "Edited a.ts" } }
  ]);
  expect(geminiRecord.title?.(file)).toBe("Fix the build");

  // `$set` with a whole message list starts over from it; an older JSON record is read whole.
  fs.appendFileSync(file, "\n" + rows({ $set: { messages: [{ id: "n1", type: "gemini", content: "compressed" }] } }));
  expect(geminiRecord.read(file)?.lines).toEqual([{ who: "agent", text: "compressed" }]);
  const old = path.join(dir, "session-old.json");
  fs.writeFileSync(old, JSON.stringify({ sessionId: "s0", messages: [{ id: "a", type: "user", content: "hello there" }, { id: "b", type: "gemini", content: "hi" }] }, null, 2));
  expect(geminiRecord.read(old)?.lines).toEqual([{ who: "person", text: "hello there" }, { who: "agent", text: "hi" }]);
  expect(geminiRecord.read(path.join(dir, "gone.jsonl"))).toBeNull();
});

it("gives a long conversation a stretch at a time, from its end back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-pages-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, rows({ sessionId: "s1", projectHash: "h" }, ...Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, type: i % 2 ? "gemini" : "user", content: `line ${i}` }))));
  const end = geminiRecord.read(file)!;
  expect(end).toMatchObject({ cut: true, start: 100 });
  expect(end.lines).toHaveLength(400);
  expect(end.lines[0]).toEqual({ who: "person", text: "line 100" });
  const before = geminiRecord.read(file, { before: end.start })!;
  expect(before).toMatchObject({ cut: false, start: 0 });
  expect(before.lines.map((l) => l.text)).toEqual(Array.from({ length: 100 }, (_, i) => `line ${i}`));
});
