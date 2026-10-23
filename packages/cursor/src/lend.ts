import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotSignedIn, type LentAnswer, type LentRequest, type LocalAgentIo, type LocalAgentOptions } from "@tomradex/plugin-sdk";

const SIGNED_OUT = /authentication required|agent login|not logged in|unauthori[sz]ed|401/i;

interface ResultLine {
  type?: string;
  is_error?: boolean;
  result?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

const fallbackDirs = new Map<string, string>();

/**
 * The same folder for every call (cursor-agent keeps a background worker and a
 * record in ~/.cursor/projects for each one it runs in), private to this user:
 * on a shared machine another user could otherwise create it first and plant
 * rules that reach every call. One that is not ours is never used.
 */
export function cursorWorkerDir(base: string = os.tmpdir()): string {
  const uid = process.getuid?.();
  const dir = path.join(base, `tomrade-cursor-worker-${uid ?? os.userInfo().username}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (stat.isDirectory() && !stat.isSymbolicLink() && (uid === undefined || stat.uid === uid)) {
    if (uid !== undefined && (stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    return dir;
  }
  let fallback = fallbackDirs.get(base);
  if (!fallback || !fs.existsSync(fallback)) fallbackDirs.set(base, (fallback = fs.mkdtempSync(path.join(base, "tomrade-cursor-worker-"))));
  return fallback;
}

/** The Model set for Cursor in Settings (`engines.cursor.model`), trimmed; none when it is empty. */
function modelOf(options: LocalAgentOptions | undefined): string | undefined {
  const model = (options as { model?: unknown } | undefined)?.model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/**
 * The signed-in cursor-agent answering one prompt (`-p --output-format json`)
 * in ask mode, which reads but never edits or runs anything, from an empty
 * folder so no project rules ride along. It has no system-prompt flag, so the
 * instructions lead the prompt on stdin.
 */
export async function cursorAsk(request: LentRequest, io: LocalAgentIo<LocalAgentOptions> & { signal?: AbortSignal }): Promise<LentAnswer> {
  const cwd = cursorWorkerDir();
  const model = modelOf(io.options);
  const args = ["-p", "--output-format", "json", "--mode", "ask", "--trust", ...(model ? ["--model", model] : [])];
  let result: ResultLine | null = null;
  const { code, stderr } = await io.cli.jsonl(args, {
    cwd,
    stdin: `${request.system}\n\n---\n\n${request.transcript}`,
    ...(io.signal ? { signal: io.signal } : {}),
    onLine: (line) => {
      if ((line as ResultLine).type === "result") result = line as ResultLine;
    }
  });
  const answer = result as ResultLine | null;
  if (!answer || answer.is_error || code !== 0 || !answer.result) {
    const why = (answer?.is_error ? answer.result : undefined) || stderr.trim().split("\n").at(-1) || `exit ${code}`;
    if (SIGNED_OUT.test(why)) throw new NotSignedIn(`Cursor is not signed in (${why}) — run \`cursor-agent login\``);
    throw new Error(`Cursor could not answer: ${why}`);
  }
  const usage = answer.usage ?? {};
  // `inputTokens` leaves out what the cache read and wrote.
  const cacheRead = usage.cacheReadTokens ?? 0;
  return { text: answer.result, inputTokens: (usage.inputTokens ?? 0) + cacheRead + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens ?? 0, cacheReadTokens: cacheRead };
}
