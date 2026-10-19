import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Runs the Google Cloud CLI, found on the PATH Tomrade reads from the login shell. */
export const gcloud = (args: string[], timeout = 20_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile("gcloud", args, { timeout, windowsHide: true, shell: process.platform === "win32" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trim());
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not recognized|command not found/i.test(stderr);
      reject(new Error(missing ? "gcloud is not installed: install the Google Cloud CLI and run `gcloud auth application-default login`, or paste a Vertex AI API key" : stderr.trim() || error.message));
    })
  );

/** The Application Default Credentials file, as `gcloud auth application-default login` writes it. */
export interface Adc {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  quota_project_id?: string;
}

/** Where Google's client libraries look for it: the file the environment names, else gcloud's own folder. */
export function adcPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const config = env.CLOUDSDK_CONFIG || (platform === "win32" ? join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "gcloud") : join(homedir(), ".config", "gcloud"));
  return join(config, "application_default_credentials.json");
}

export async function readAdc(path = adcPath()): Promise<Adc | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Adc;
  } catch {
    return null;
  }
}

/** An access token, and whether it is a person's own: Vertex wants those to name the project their use is billed to. */
export interface GoogleToken {
  token: string;
  user: boolean;
  quotaProject?: string;
}

interface Fetched {
  value: GoogleToken;
  expires: number;
}

/** A person's ADC refresh token exchanged for an access token, as Google's client libraries do. */
async function exchange(adc: Adc): Promise<Fetched> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: adc.client_id ?? "", client_secret: adc.client_secret ?? "", refresh_token: adc.refresh_token ?? "" })
  }).catch((error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`Could not reach Google to sign in with the Application Default Credentials (${cause})`);
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    const why = [body.error, body.error_description].filter(Boolean).join(": ");
    throw new Error(`Google turned down the Application Default Credentials (${res.status}${why ? ` ${why}` : ""}): run \`gcloud auth application-default login\` again`);
  }
  return { value: { token: body.access_token, user: true, ...(adc.quota_project_id ? { quotaProject: adc.quota_project_id } : {}) }, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

interface Helper {
  credential?: { access_token?: string; token_expiry?: string };
  configuration?: { properties?: { core?: { account?: string }; billing?: { quota_project?: string } } };
}

/** gcloud's own credentials. config-helper says when its token expires, which print-access-token does not. */
async function fromGcloud(run: typeof gcloud): Promise<Fetched> {
  const ask = async (args: string[] = []): Promise<Fetched> => {
    const out = JSON.parse(await run(["config", "config-helper", "--format=json", ...args])) as Helper;
    const token = out.credential?.access_token;
    if (!token) throw new Error("gcloud has no credentials: run `gcloud auth application-default login`, or paste a Vertex AI API key");
    const expiry = Date.parse(out.credential?.token_expiry ?? "");
    const { core, billing } = out.configuration?.properties ?? {};
    // a service account bills its own project; a person's sign-in needs one named, as Vertex says when it is missing
    const user = !/\.gserviceaccount\.com$/.test(core?.account ?? "");
    const quota = billing?.quota_project && billing.quota_project !== "CURRENT_PROJECT" ? billing.quota_project : "";
    return { value: { token, user, ...(user && quota ? { quotaProject: quota } : {}) }, expires: Number.isFinite(expiry) ? expiry : Date.now() + 10 * 60_000 };
  };
  const first = await ask();
  // gcloud hands back a cached token until it is all but spent
  return first.expires - Date.now() < 5 * 60_000 ? ask(["--force-auth-refresh"]) : first;
}

/**
 * The token requests go with: the ADC file's refresh token exchanged for one,
 * else gcloud's own credentials (a service account, or no ADC file at all).
 * Held until five minutes before it expires; concurrent callers share one fetch.
 */
export function googleToken(adc: () => Promise<Adc | null> = readAdc, run = gcloud): () => Promise<GoogleToken> {
  let held: Fetched | null = null;
  let pending: Promise<GoogleToken> | null = null;
  return async () => {
    if (held && Date.now() < held.expires - 5 * 60_000) return held.value;
    pending ??= (async () => {
      try {
        const file = await adc();
        held = file?.type === "authorized_user" && file.refresh_token ? await exchange(file) : await fromGcloud(run);
        return held.value;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

/** The project to work in: the environment's, else gcloud's, else the one the ADC file bills. */
export async function defaultProject(run = gcloud, adc: () => Promise<Adc | null> = readAdc): Promise<string> {
  const env = process.env.GOOGLE_CLOUD_PROJECT || process.env.CLOUDSDK_CORE_PROJECT;
  if (env?.trim()) return env.trim();
  const configured = (await run(["config", "get-value", "project"], 5_000).catch(() => "")).split("\n").pop()?.trim() ?? "";
  // an unset value comes back as "(unset)"
  if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(configured)) return configured;
  return (await adc())?.quota_project_id ?? "";
}
