import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agy } from "../src/agy.js";
import { agyRecord, agyRequest, agyTranscript } from "../src/record.js";

// Written in the shape agy 1.4.7 writes brain/<id>/.system_generated/logs/transcript.jsonl (values of a call's
// arguments JSON-encoded, results as later steps), not copied from one.
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "transcript.jsonl");
const ID = "6d1f4b2e-9c3a-4e57-8b0d-2f7a9e1c5b38";

let home = "";
const savedHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-record-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
});

it("declares agy's own transcripts as its record, so its ended terminal sessions show their conversation", () => {
  expect(agy.record).toBe(agyRecord);
});

it("reads a transcript: the request without agy's metadata, its calls with their results in order, its answer", () => {
  expect(agyRecord.read(FIXTURE)).toEqual({
    lines: [
      { who: "person", text: "Claim TOM-2, then count the files in this folder." },
      { who: "tool", text: "call_mcp_tool · Claim ticket TOM-2", detail: { input: JSON.stringify({ Arguments: '{"key":"TOM-2"}', ServerName: "tomrade", ToolName: "claim_ticket" }, null, 2), output: "ERROR: claim_ticket: invalid arguments — projectId: required here" } },
      { who: "tool", text: "run_command · Count files", detail: { input: "$ ls | wc -l", output: "3" } },
      { who: "agent", text: "There are 3 files. The claim needs a project id." }
    ],
    cut: false,
    start: 0
  });
  expect(agyRecord.title?.(FIXTURE)).toBe("Claim TOM-2, then count the files in this folder.");
});

it("finds a conversation's transcript under ~/.gemini/antigravity-cli/brain by its id", () => {
  const file = agyTranscript(path.join(home, ".gemini", "antigravity-cli"), ID);
  expect(agyRecord.find(ID, { cwd: null })).toBeNull();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(FIXTURE, file);
  expect(agyRecord.find(ID, { cwd: "/home/me/demo" })).toBe(file);
  expect(agyRecord.find("../../x", { cwd: null })).toBeNull();
  expect(agyRecord.read(path.join(home, "gone.jsonl"))).toBeNull();
});

it("takes the person's words out of agy's wrapping, and leaves out wrapped context with no request", () => {
  expect(agyRequest("<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>")).toBe("hi");
  expect(agyRequest("plain")).toBe("plain");
  expect(agyRequest("<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>")).toBeNull();
});

it("gives a long conversation a stretch at a time, from its end back", () => {
  const file = path.join(home, "long.jsonl");
  fs.writeFileSync(file, Array.from({ length: 450 }, (_, i) => JSON.stringify({ step_index: i, source: "MODEL", type: "PLANNER_RESPONSE", content: `said ${i}` })).join("\n"));
  const end = agyRecord.read(file)!;
  expect(end).toMatchObject({ cut: true, start: 50 });
  expect(end.lines).toHaveLength(400);
  const before = agyRecord.read(file, { before: end.start })!;
  expect(before).toMatchObject({ cut: false, start: 0 });
  expect(before.lines.map((l) => l.text)).toEqual(Array.from({ length: 50 }, (_, i) => `said ${i}`));
});
