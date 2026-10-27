import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { expect, it } from "vitest";
import { dsh } from "../src/dsh.js";
import { dshLogText, dshRecord, dshSessionsDir, findDshSession } from "../src/record.js";

// Written in the shape DeepSeek Harness writes its session log (format 4), not copied from one.
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "session.v4.jsonl");
const ID = "8e3b5d21-4f6a-4c0e-9b7d-1a2c3e4f5a6b";

/** The log as dsh stores it: every event appended as a Zstandard frame of its own. */
const compressed = (text: string) => Buffer.concat(text.split(/(?<=\n)/).map((row) => zlib.zstdCompressSync(Buffer.from(row))));

/** A dsh home holding the fixture as a session of one working folder, under `name`. */
function sessions(name = ID, log = "session.v4.jsonl.zstd"): { dir: string; file: string } {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-")), "sessions");
  const file = path.join(dir, "--home-me-demo--", name, log);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(dir, "--home-me-other--"));
  const text = fs.readFileSync(FIXTURE, "utf8");
  fs.writeFileSync(file, log.endsWith(".zstd") ? compressed(text) : text);
  return { dir, file };
}

it("declares DeepSeek Harness's own session logs as its record, so its ended terminal sessions show their conversation", () => {
  expect(dsh.record).toBe(dshRecord);
});

it("reads a compressed session log: the person's words, dsh's words, its tool calls with their results; not the context dsh adds", () => {
  const { file } = sessions();
  expect(dshRecord.read(file)).toEqual({
    lines: [
      { who: "person", text: "Work on TOM-7: count the files in this folder." },
      { who: "agent", text: "Claiming the ticket, then counting." },
      { who: "tool", text: "mcp__tomrade__claim_ticket", detail: { input: JSON.stringify({ key: "TOM-7" }, null, 2), output: '{"key":"TOM-7","branch":"tom-7/count"}' } },
      { who: "tool", text: "bash · Count the files", detail: { input: "$ ls | wc -l", output: "3" } },
      { who: "agent", text: "TOM-7 is claimed; this folder holds 3 files." }
    ],
    cut: false,
    start: 0
  });
  // The last title dsh gave it.
  expect(dshRecord.title?.(file)).toBe("Count the files for TOM-7");
});

it("takes every frame of the log, and stops at one still being written", () => {
  const text = fs.readFileSync(FIXTURE, "utf8");
  const whole = compressed(text);
  expect(dshLogText(whole, true)).toBe(text);
  const half = Buffer.concat([whole, zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n')).subarray(0, 6)]);
  expect(dshLogText(half, true)).toBe(text);
  expect(dshLogText(Buffer.from(text), false)).toBe(text);
});

it("finds a session by its id in whichever working folder it ran, older `session-` names and plain logs included", () => {
  const { dir, file } = sessions();
  expect(findDshSession(ID, dir)).toBe(file);
  expect(findDshSession("missing", dir)).toBeNull();
  expect(findDshSession("../x", dir)).toBeNull();
  expect(findDshSession(ID, path.join(dir, "nowhere"))).toBeNull();
  const old = sessions(`session-${ID}`, "session.jsonl");
  expect(findDshSession(ID, old.dir)).toBe(old.file);
  expect(findDshSession(`session-${ID}`, old.dir)).toBe(old.file);
  expect(dshRecord.read(old.file)?.lines).toHaveLength(5);
  expect(dshRecord.read(path.join(dir, "gone.jsonl.zstd"))).toBeNull();
  expect(dshSessionsDir({ DSH_HOME: "/opt/dsh" })).toBe(path.join("/opt/dsh", "sessions"));
});

it("gives a long session a stretch at a time, from its end back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-long-"));
  const file = path.join(dir, "session.v4.jsonl");
  fs.writeFileSync(file, Array.from({ length: 450 }, (_, i) => JSON.stringify({ type: "assistant/message", data: { message: { content: [{ type: "text", text: `said ${i}` }] } } })).join("\n"));
  const end = dshRecord.read(file)!;
  expect(end).toMatchObject({ cut: true, start: 50 });
  const before = dshRecord.read(file, { before: end.start })!;
  expect(before).toMatchObject({ cut: false, start: 0 });
  expect(before.lines.map((l) => l.text)).toEqual(Array.from({ length: 50 }, (_, i) => `said ${i}`));
});
