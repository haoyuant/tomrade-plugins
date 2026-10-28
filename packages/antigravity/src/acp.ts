import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Google's ACP server keeps its own settings and sign-in, apart from agy's: `$GEMINI_HOME/antigravity-acp`. */
export const acpSettingsFile = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string =>
  path.join(env.GEMINI_HOME || path.join(home, ".gemini"), "antigravity-acp", "settings.json");

/**
 * The ACP server signs in only by the `auth.type` its own settings name; without one every session is
 * `auth_required`, however agy is signed in. Missing, it is the Gemini API key when one is in the environment, else
 * Google sign-in, which the server's first session opens in the browser. A type the person chose, their other
 * settings, and a file that does not parse are left as they are.
 */
export function chooseAcpSignIn(env: NodeJS.ProcessEnv = process.env, file = acpSettingsFile(env)): void {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const auth = settings.auth;
  if (auth !== undefined && (!auth || typeof auth !== "object" || Array.isArray(auth))) return;
  if ((auth as { type?: unknown } | undefined)?.type) return;
  const type = env.GEMINI_API_KEY ? "gemini-api-key" : "oauth-personal";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...settings, auth: { ...(auth as object | undefined), type } }, null, 2)}\n`);
}

/**
 * The server talks to its own harness over a websocket on 127.0.0.1, which a macOS SOCKS system proxy would
 * otherwise take, and fail at: it ships without SOCKS support. A proxy in the environment (Tomrade sets one from
 * the system's HTTP proxy) still carries the rest.
 */
export function localBypass(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const listed = [env.NO_PROXY, env.no_proxy].flatMap((value) => value?.split(",") ?? []).map((host) => host.trim()).filter(Boolean);
  const value = [...new Set([...listed, "127.0.0.1", "localhost"])].join(",");
  return { NO_PROXY: value, no_proxy: value };
}
