import type { ModelListing, ModelMedia } from "@tomradex/plugin-sdk";
import type { GoogleToken } from "./credentials.js";

/** The host of a location: the global endpoint has none in its name, and the `us` and `eu` multi-regions have their own. */
export const hostOf = (location: string): string =>
  location === "global" ? "aiplatform.googleapis.com" : /^(us|eu)$/.test(location) ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;

/** Where the publishers' models are listed for a location; the global and multi-region endpoints list nothing themselves. */
const listingHost = (location: string): string => hostOf(location === "eu" ? "europe-west4" : location === "global" || location === "us" ? "us-central1" : location);

export const base = (project: string, location = "global"): string => `https://${hostOf(location)}/v1/projects/${project}/locations/${location}`;

/** Where an API key reaches Gemini: no project or location, which the key brings with it. */
export const KEYED = "https://aiplatform.googleapis.com/v1";

const PATH = /\/?projects\/([^/]+)\/locations\/([^/?#]+)/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The base a profile talks to: a full one, regional included, `projects/{p}/locations/{l}`, or a bare project id. */
export function address(input: string | undefined, fallback: string): string {
  const value = (input ?? "").trim().replace(/\/+$/, "");
  if (!value) return fallback;
  if (PROJECT.test(value)) return base(value);
  if (/^\/?projects\//.test(value)) {
    const path = PATH.exec(value);
    return path ? base(path[1]!, path[2]!) : fallback;
  }
  const url = /^https?:\/\//.test(value) ? value : `https://${value}`;
  const at = PATH.exec(url);
  // anything after the location, such as a model pasted with it, is left out
  return at ? url.slice(0, at.index + at[0].length) : url;
}

export const projectOf = (baseURL: string): string => PATH.exec(baseURL)?.[1] ?? "";
export const locationOf = (baseURL: string): string => PATH.exec(baseURL)?.[2] ?? "global";

/** How a request is let in: an API key, else a Google access token. */
export interface Auth {
  apiKey: string;
  token: () => Promise<GoogleToken>;
}

/** A person's own credentials name the project their use is billed to; Google's client libraries send the ADC file's quota project. */
export async function authorize(auth: Auth, project: string): Promise<Record<string, string>> {
  if (auth.apiKey.trim()) return { "x-goog-api-key": auth.apiKey.trim() };
  const { token, user, quotaProject } = await auth.token();
  const billed = user ? quotaProject || project : "";
  return { authorization: `Bearer ${token}`, ...(billed ? { "x-goog-user-project": billed } : {}) };
}

/** What Google said of a failed request, with its status. */
export function googleError(status: number, text: string): string {
  let message = text;
  let kind = "";
  try {
    const json = JSON.parse(text) as { error?: { message?: string; status?: string } } | { error?: { message?: string; status?: string } }[];
    const error = (Array.isArray(json) ? json[0] : json)?.error;
    if (error?.message) [message, kind] = [error.message, error.status ?? ""];
  } catch {}
  return `${status}${kind ? ` ${kind}` : ""}: ${message.slice(0, 400)}`;
}

/** Anthropic's Claude on Vertex, typed bare or with its publisher: the id its publisher path takes, else null. */
export const claudeId = (model: string): string | null => {
  const id = model.replace(/^(publishers\/anthropic\/models\/|anthropic\/)/, "");
  return /^claude-/.test(id) ? id : null;
};

/** Vertex's open models (MaaS) by their `publisher/model` id: anything with a publisher other than Google's or Anthropic's, or a `-maas` id. */
export const open = (model: string): boolean => !claudeId(model) && ((model.includes("/") && !/^(google\/|publishers\/google\/models\/)/.test(model)) || /-maas$/.test(model));

/** A Gemini id as the publisher path takes it, typed bare or with Google's prefix. */
export const geminiId = (model: string): string => model.replace(/^(publishers\/google\/models\/|google\/)/, "");

/** Gemini models that answer in text: not the image, speech, live, transcription or embedding ones. */
const NOT_CHAT = /embedding|image|tts|live|transcribe|translate|computer-use|audio|robotics/i;
export const geminiChat = (id: string): boolean => /^gemini-\d/.test(id) && !NOT_CHAT.test(id);

/** What an API key is offered, since a key cannot list models. */
export const KEY_MODELS = ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"];

/**
 * Open models Vertex serves on its OpenAI-compatible endpoint. Google lists
 * them under each publisher; these are the GA ones its listing named on
 * 2026-10-20 (Google's own `-maas` models come from the Gemini listing).
 */
export const MAAS = [
  "openai/gpt-oss-120b-maas",
  "deepseek-ai/deepseek-v3.2-maas",
  "deepseek-ai/deepseek-v3.1-maas",
  "deepseek-ai/deepseek-r1-0528-maas",
  "qwen/qwen3-235b-a22b-instruct-2507-maas",
  "qwen/qwen3-next-80b-a3b-instruct-maas",
  "qwen/qwen3-next-80b-a3b-thinking-maas",
  "qwen/qwen3-coder-480b-a35b-instruct-maas",
  "moonshotai/kimi-k2-thinking-maas",
  "zai-org/glm-4.7-maas",
  "minimaxai/minimax-m2-maas",
  "meta/llama-4-maverick-17b-128e-instruct-maas",
  "meta/llama-3.3-70b-instruct-maas"
];

/** The Claude models Vertex served on 2026-10-20, for a project whose listing of Anthropic's cannot be read. */
export const CLAUDE = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"];

export const NO_PROJECT = "No Google Cloud project is set. Type your project id in the profile's address, or run `gcloud config set project <your-project-id>` and restart Tomrade.";

/**
 * Google's Gemini models that write text, then the open models; doubles as the
 * check of the credentials. A global profile reads us-central1's listing.
 */
export async function listModels(baseURL: string, auth: Auth, signal: AbortSignal): Promise<ModelListing> {
  if (auth.apiKey.trim()) return { ok: true, models: KEY_MODELS };
  const project = projectOf(baseURL);
  if (!project) return { ok: false, detail: NO_PROJECT };
  const location = locationOf(baseURL);
  try {
    const listed: string[] = [];
    let next = "";
    for (let page = 0; page < 10; page += 1) {
      const url = `https://${listingHost(location)}/v1beta1/publishers/google/models?listAllVersions=false&pageSize=300${next ? `&pageToken=${encodeURIComponent(next)}` : ""}`;
      const res = await fetch(url, { headers: await authorize(auth, project), signal });
      if (!res.ok) return { ok: false, status: res.status, detail: googleError(res.status, await res.text().catch(() => "")) };
      const body = (await res.json()) as { publisherModels?: { name?: string }[]; nextPageToken?: string };
      for (const m of body.publisherModels ?? []) listed.push(m.name?.split("/").pop() ?? "");
      next = body.nextPageToken ?? "";
      if (!next) break;
    }
    const claude = await fetch(`https://${listingHost(location)}/v1beta1/publishers/anthropic/models?pageSize=300`, { headers: await authorize(auth, project), signal })
      .then(async (res) => (res.ok ? ((await res.json()) as { publisherModels?: { name?: string }[] }).publisherModels?.map((m) => m.name?.split("/").pop() ?? "").filter((id) => id.startsWith("claude-")) : null))
      .catch(() => null);
    return { ok: true, models: [...listed.filter(geminiChat), ...(claude?.length ? claude : CLAUDE), ...listed.filter((id) => id.endsWith("-maas")).map((id) => `google/${id}`), ...MAAS] };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** A Claude id's version, `claude-sonnet-5-5` → 505, for newest first. */
const versionOf = (id: string): number => {
  const [, major = "0", minor = "0"] = /-(\d+)(?:-(\d+))?(?:@|$)/.exec(id) ?? [];
  return Number(major) * 100 + (minor.length > 2 ? 0 : Number(minor));
};
const FAMILIES = ["sonnet", "opus", "haiku"];
const familyOf = (id: string): number => {
  const at = FAMILIES.findIndex((f) => id.includes(`-${f}-`));
  return at < 0 ? FAMILIES.length : at;
};

/** Gemini first, the newest first; then Claude, the newest first; then the open models as listed. */
export function usable(listed: string[]): string[] {
  const gemini = listed.filter((id) => !open(id) && !claudeId(id) && geminiChat(geminiId(id))).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const claude = listed.filter((id) => claudeId(id)).sort((a, b) => versionOf(claudeId(b)!) - versionOf(claudeId(a)!) || familyOf(a) - familyOf(b) || a.localeCompare(b));
  return [...new Set([...gemini, ...claude, ...listed.filter(open)])];
}

export const GEMINI_MEDIA: ModelMedia = { inputModalities: ["image", "pdf", "audio", "video"], outputModalities: [] };

export const CLAUDE_MEDIA: ModelMedia = { inputModalities: ["image", "pdf"], outputModalities: [] };

/** Gemini reads pictures, PDFs, sound and video, Claude pictures and PDFs; what the open models read is left to the profile. */
export const media = (model: string, listed?: ModelMedia): ModelMedia | undefined =>
  listed ?? (claudeId(model) ? CLAUDE_MEDIA : !open(model) && /^gemini-/.test(geminiId(model)) ? GEMINI_MEDIA : undefined);
