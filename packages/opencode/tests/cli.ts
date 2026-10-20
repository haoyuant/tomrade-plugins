import { spawn } from "node:child_process";
import readline from "node:readline";
import type { LocalAgentIo, LocalCli, LocalCliResult, LocalCliRunOptions } from "@tomradex/plugin-sdk";

const envOf = (add: LocalCliRunOptions["env"]) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(add ?? {})) if (value === undefined) delete env[key]; else env[key] = value;
  return env;
};

/** The CLI handle Tomrade gives the plugin, over a script standing in for the agent. */
export function fakeCli(bin: string, name = "opencode"): LocalCli {
  const start = (args: string[], opts: LocalCliRunOptions) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: envOf(opts.env), stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    opts.signal?.addEventListener("abort", () => child.kill(), { once: true });
    return child;
  };
  return {
    name,
    run: (args, opts = {}) =>
      new Promise<LocalCliResult>((resolve) => {
        const child = start(args, opts);
        let stdout = "";
        let stderr = "";
        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("close", (code) => resolve(opts.signal?.aborted ? { code: null, stdout, stderr: "stopped", error: { message: "stopped", killed: true } } : { code, stdout, stderr }));
      }),
    jsonl: (args, opts) =>
      new Promise((resolve) => {
        const child = start(args, opts);
        let stderr = "";
        child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        readline.createInterface({ input: child.stdout! }).on("line", (line) => {
          try { opts.onLine(JSON.parse(line)); } catch { /* not a JSON line */ }
        });
        child.on("close", (code) => resolve({ code, stderr }));
      })
  };
}

export const MCP = { url: "http://127.0.0.1:19090/mcp/test", eventUrl: "http://127.0.0.1:19090/sessions/event" };

export const io = <O>(cli: LocalCli, options: O, mcp = MCP): LocalAgentIo<O> => ({ cli, mcp, options });
