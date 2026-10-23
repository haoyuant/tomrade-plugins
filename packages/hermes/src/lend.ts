import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotSignedIn, type LentAnswer, type LentRequest, type LocalAgentIo } from "@tomradex/plugin-sdk";
import { fitsCommandLine } from "./command-line.js";
import type { HermesOptions } from "./hermes.js";

// Before the reply: Hermes has no first-run provider yet, or no key for it.
const SIGNED_OUT = /hermes (setup|model)|no (inference )?provider|no api key|api key (is )?(missing|not set)/i;
// Hermes takes a one-shot prompt only as an argument, so a request this platform's command line cannot hold is refused.
const TOO_LONG = {
  en: "Hermes could not answer: this request is too long for this computer's command line, the only way Hermes takes a one-shot prompt",
  zh: "Hermes 无法回答：这次请求太长，超出了这台电脑命令行能传递的长度，而 Hermes 只能从命令行接收单次提示词"
};

interface UsageFile {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  failed?: boolean | null;
  auxiliary?: { input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number };
}

/**
 * The signed-in Hermes answering one prompt (`hermes -z`): no tools beyond its
 * small todo list (a toolset that also names no MCP server, so none is
 * started), no AGENTS.md, memory or skills. It has no system-prompt flag, so
 * the instructions lead the prompt. Its titling calls count toward the spend.
 */
export async function hermesAsk(request: LentRequest, io: LocalAgentIo<HermesOptions> & { signal?: AbortSignal }, locale = "en"): Promise<LentAnswer> {
  const prompt = `${request.system}\n\n---\n\n${request.transcript}`;
  const { model } = io.options;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hermes-lent-"));
  const usageFile = path.join(tmp, "usage.json");
  try {
    const args = ["-z", prompt, "-t", "todo", "--ignore-rules", "--usage-file", usageFile, ...(model ? ["-m", model] : [])];
    if (!fitsCommandLine([io.cli.name, ...args])) throw new Error(simplifiedChinese(locale) ? TOO_LONG.zh : TOO_LONG.en);
    const run = await io.cli.run(args, { cwd: tmp, env: { NO_COLOR: "1" }, ...(io.signal ? { signal: io.signal } : {}) });
    let usage: UsageFile = {};
    try { usage = JSON.parse(fs.readFileSync(usageFile, "utf8")) as UsageFile; } catch { /* an early failure writes none */ }
    const text = run.stdout.trim();
    if (run.code !== 0 || usage.failed || !text) {
      const why = (text || run.stderr.trim() || `exit ${run.code}`).split("\n").filter(Boolean).slice(0, 2).join(" ");
      if (SIGNED_OUT.test(why)) throw new NotSignedIn(`Hermes has no model it can use (${why}) — run \`hermes setup\` to choose a provider and add its key`);
      throw new Error(`Hermes could not answer: ${why}`);
    }
    const aux = usage.auxiliary ?? {};
    const read = (usage.cache_read_tokens ?? 0) + (aux.cache_read_tokens ?? 0);
    // Hermes counts cached prompt tokens apart from input_tokens.
    return {
      text,
      inputTokens: (usage.input_tokens ?? 0) + (aux.input_tokens ?? 0) + read + (usage.cache_write_tokens ?? 0) + (aux.cache_write_tokens ?? 0),
      outputTokens: (usage.output_tokens ?? 0) + (aux.output_tokens ?? 0),
      ...(usage.cache_read_tokens != null ? { cacheReadTokens: read } : {})
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Whether a language tag reads in Simplified Chinese: zh-TW does not. */
function simplifiedChinese(tag: string): boolean {
  try { const l = new Intl.Locale(tag).maximize(); return l.language === "zh" && l.script === "Hans"; } catch { return false; }
}
