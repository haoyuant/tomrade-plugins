import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { cursor } from "../src/cursor.js";
import { cursorPrompt, cursorRecord, findCursorTranscript } from "../src/record.js";

// Written in the shape cursor-agent 2026.10.22 writes its transcripts (TranscriptStore's JSONL), not copied from one.
const ID = "3f0c2a51-8d4e-4b7a-9c61-2e5d7f9a1b04";
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", `${ID}.jsonl`);

it("declares cursor-agent's own transcripts as its record, so its ended terminal sessions show their conversation", () => {
  expect(cursor.record).toBe(cursorRecord);
});

it("reads a transcript: the person's query without Cursor's wrapping, its replies, and its tool calls", () => {
  expect(cursorRecord.read(FIXTURE)).toEqual({
    lines: [
      { who: "person", text: "Add a line to the end of README.md: cursor test" },
      { who: "agent", text: "Claiming the ticket first, then editing the README." },
      { who: "tool", text: "CallDynamicTool · claim_ticket", detail: { input: JSON.stringify({ namespace: "tomrade", toolName: "claim_ticket", mcpDetails: { description: "Claim TES-12 and get the working branch" }, arguments: { key: "TES-12" } }, null, 2) } },
      { who: "tool", text: "Read · /home/me/demo/README.md", detail: { input: JSON.stringify({ path: "/home/me/demo/README.md" }, null, 2) } },
      { who: "tool", text: "Shell · Create the ticket branch", detail: { input: "$ git switch -c tes-12/cursor-test" } },
      { who: "tool", text: "StrReplace · /home/me/demo/README.md", detail: { input: "/home/me/demo/README.md\n- claude test\n- \n+ claude test\n+ cursor test\n+ " } },
      { who: "agent", text: "Added `cursor test` to the end of README.md on tes-12/cursor-test." }
    ],
    cut: false,
    start: 0
  });
  expect(cursorRecord.title?.(FIXTURE)).toBe("Add a line to the end of README.md: cursor test");
  expect(cursorRecord.read(path.join(os.tmpdir(), "no-such-transcript.jsonl"))).toBeNull();
});

it("takes the person's words out of Cursor's wrapping, and leaves out wrapped context with no query", () => {
  expect(cursorPrompt("<timestamp>now</timestamp>\n<user_query>\nhello\n</user_query>")).toBe("hello");
  expect(cursorPrompt("plain words")).toBe("plain words");
  expect(cursorPrompt("<system_reminder>rules</system_reminder>")).toBeNull();
  expect(cursorPrompt("<user_query>\n</user_query>")).toBeNull();
});

it("finds a transcript by its conversation id under any project's folder, older layouts included", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-"));
  const nested = path.join(home, ".cursor", "projects", "home-me-demo", "agent-transcripts", ID);
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "projects", "empty-window"));
  fs.copyFileSync(FIXTURE, path.join(nested, `${ID}.jsonl`));
  expect(findCursorTranscript(ID, home)).toBe(path.join(nested, `${ID}.jsonl`));
  const flat = path.join(home, ".cursor", "projects", "home-me-old", "agent-transcripts");
  fs.mkdirSync(flat, { recursive: true });
  fs.writeFileSync(path.join(flat, "old-1.jsonl"), "");
  expect(findCursorTranscript("old-1", home)).toBe(path.join(flat, "old-1.jsonl"));
  expect(findCursorTranscript("missing", home)).toBeNull();
  expect(findCursorTranscript("../../x", home)).toBeNull();
  expect(findCursorTranscript(ID, path.join(home, "nowhere"))).toBeNull();
});

it("reads a long transcript a stretch at a time, from its end back, in whole lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-long-"));
  const file = path.join(dir, "long.jsonl");
  const row = (i: number) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: `${i} ${"x".repeat(2000)}` }] } });
  fs.writeFileSync(file, Array.from({ length: 1500 }, (_, i) => row(i)).join("\n") + "\n");
  const end = cursorRecord.read(file)!;
  expect(end.cut).toBe(true);
  expect(end.lines.at(-1)?.text.startsWith("1499 ")).toBe(true);
  const before = cursorRecord.read(file, { before: end.start })!;
  expect(before.cut).toBe(false);
  expect(before.start).toBe(0);
  expect(before.lines.length + end.lines.length).toBe(1500);
  expect(before.lines[0]?.text.startsWith("0 ")).toBe(true);
});
