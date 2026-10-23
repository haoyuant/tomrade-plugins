import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where CodeBuddy keeps its own state: CODEBUDDY_CONFIG_DIR, else ~/.codebuddy. */
export const codebuddyConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CODEBUDDY_CONFIG_DIR?.trim() || path.join(os.homedir(), ".codebuddy");

/** Its user settings, the file the CLI reads before every run. */
export const codebuddySettingsFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(codebuddyConfigDir(env), "settings.json");

export type Region = "auto" | "china" | "international";

/** What each edition writes into the CLI's own environment. */
const REGION_ENV: Record<Exclude<Region, "auto">, string> = { china: "internal", international: "public" };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The settings as they are now: {} when absent, null when the file is unreadable and must not be rewritten. */
function readSettings(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Another program may be writing them too: replace the file in one step, never leave a half-written one. */
function writeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tomrade-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The edition the CLI would use now: the process environment, then its settings, then the international default. */
export function effectiveRegion(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.CODEBUDDY_INTERNET_ENVIRONMENT?.trim().toLowerCase();
  if (declared) return declared;
  const settings = readSettings(codebuddySettingsFile(env));
  const configured = isRecord(settings?.env) ? settings.env.CODEBUDDY_INTERNET_ENVIRONMENT : undefined;
  return typeof configured === "string" && configured.trim() ? configured.trim().toLowerCase() : "public";
}

/**
 * Writes the chosen edition into the CLI's own settings, merging the env map
 * and every other setting. `auto` has nothing to write. Answers what happened
 * so the caller can log a refusal without failing the session.
 */
export function setRegionFile(region: Exclude<Region, "auto">, env: NodeJS.ProcessEnv = process.env): "written" | "unchanged" | "unreadable" {
  const file = codebuddySettingsFile(env);
  const settings = readSettings(file);
  if (!settings) return "unreadable";
  if (settings.env !== undefined && !isRecord(settings.env)) return "unreadable";
  const next = { ...(settings.env ?? {}) };
  const value = REGION_ENV[region];
  if (next.CODEBUDDY_INTERNET_ENVIRONMENT === value) return "unchanged";
  next.CODEBUDDY_INTERNET_ENVIRONMENT = value;
  writeSettings(file, { ...settings, env: next });
  return "written";
}

/** Takes back the value Tomrade wrote, and only while it is still that value; anything else stays the person's. */
export function clearRegionFile(region: Exclude<Region, "auto">, env: NodeJS.ProcessEnv = process.env): "cleared" | "kept" | "unreadable" {
  const file = codebuddySettingsFile(env);
  const settings = readSettings(file);
  if (!settings) return "unreadable";
  if (!isRecord(settings.env)) return "kept";
  const expected = REGION_ENV[region];
  if (settings.env.CODEBUDDY_INTERNET_ENVIRONMENT !== expected) return "kept";
  const next = { ...settings.env };
  delete next.CODEBUDDY_INTERNET_ENVIRONMENT;
  const rest = { ...settings };
  if (Object.keys(next).length) rest.env = next;
  else delete rest.env;
  writeSettings(file, rest);
  return "cleared";
}

/** What the session process should carry for a chosen edition; auto adds nothing. */
export function regionEnv(region: Region = "auto"): Record<string, string> {
  return region === "auto" || !(region in REGION_ENV) ? {} : { CODEBUDDY_INTERNET_ENVIRONMENT: REGION_ENV[region] };
}
