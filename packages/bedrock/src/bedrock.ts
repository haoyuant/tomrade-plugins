import type { ModelListing, ModelMedia } from "@tomradex/plugin-sdk";
import { sign, type AwsCredentials } from "./sigv4.js";

export const DEFAULT_REGION = "us-east-1";

export const runtime = (region: string): string => `https://bedrock-runtime.${region}.amazonaws.com`;

const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const RUNTIME = /^https:\/\/bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/;

/** The runtime address a profile talks to: a region name typed in the address field is enough. */
export function address(input: string | undefined, fallback: string): string {
  const value = (input ?? "").trim().replace(/\/+$/, "");
  if (!value) return fallback;
  if (REGION.test(value)) return runtime(value);
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

export const regionOf = (baseURL: string): string => RUNTIME.exec(baseURL)?.[1] ?? DEFAULT_REGION;

/** How a request is let in: a Bedrock API key as a bearer token, else the AWS CLI's credentials signing it. */
export interface Auth {
  apiKey: string;
  credentials: () => Promise<AwsCredentials>;
}

export async function authorize(request: { method: string; url: string; body?: string }, auth: Auth, region: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = request.body !== undefined ? { "content-type": "application/json" } : {};
  if (auth.apiKey.trim()) return { ...headers, authorization: `Bearer ${auth.apiKey.trim()}` };
  return sign({ ...request, headers }, await auth.credentials(), { region, service: "bedrock" });
}

/** What AWS said of a failed request, with its error type. */
export async function failure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const json = JSON.parse(text) as { message?: string; Message?: string };
    message = json.message ?? json.Message ?? text;
  } catch {}
  const type = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0];
  return `${res.status}${type ? ` ${type}` : ""}: ${message.slice(0, 300)}`;
}

interface FoundationModel {
  modelId: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}

interface InferenceProfile {
  inferenceProfileId: string;
  status?: string;
  models?: { modelArn?: string }[];
}

/** Text out, but not a chat model: embeddings, guard and video-analysis models. */
const NOT_CHAT = /embed|rerank|safeguard|guard|pegasus|marengo/i;

/** VL models read pictures by the listing; Claude and Nova also read documents through Converse. */
export function mediaOf(model: string, inputs: string[] = []): ModelMedia | undefined {
  const image = inputs.includes("IMAGE");
  const pdf = /(^|\.)(anthropic\.claude|amazon\.nova)/.test(model);
  if (!image && !pdf) return undefined;
  return { inputModalities: [...(image ? ["image" as const] : []), ...(pdf ? ["pdf" as const] : [])], outputModalities: [] };
}

/**
 * The models a profile can call: on-demand ones by their id, and every system
 * inference profile of a chat model, which is the only way to reach the models
 * served cross-region (`global.anthropic.claude-…`).
 */
export function chatModels(foundation: FoundationModel[], profiles: InferenceProfile[]): { models: string[]; capabilities: Record<string, ModelMedia> } {
  const chat = new Map<string, FoundationModel>();
  for (const m of foundation) {
    if (NOT_CHAT.test(m.modelId) || m.responseStreamingSupported === false) continue;
    if (!(m.inputModalities ?? []).includes("TEXT") || !(m.outputModalities ?? []).includes("TEXT")) continue;
    if (m.modelLifecycle?.status && m.modelLifecycle.status !== "ACTIVE") continue;
    chat.set(m.modelId, m);
  }
  const models: string[] = [];
  const capabilities: Record<string, ModelMedia> = {};
  const add = (id: string, of: FoundationModel) => {
    if (models.includes(id)) return;
    models.push(id);
    const media = mediaOf(id, of.inputModalities);
    if (media) capabilities[id] = media;
  };
  for (const m of chat.values()) if ((m.inferenceTypesSupported ?? ["ON_DEMAND"]).includes("ON_DEMAND")) add(m.modelId, m);
  for (const p of profiles) {
    if (p.status && p.status !== "ACTIVE") continue;
    const of = (p.models ?? []).map((m) => chat.get(m.modelArn?.split("/").pop() ?? "")).find(Boolean);
    if (of) add(p.inferenceProfileId, of);
  }
  return { models, capabilities };
}

/** List calls go to the control plane, signed for the same service. */
async function control(path: string, auth: Auth, region: string, signal: AbortSignal): Promise<Response> {
  const url = `https://bedrock.${region}.amazonaws.com${path}`;
  return fetch(url, { headers: await authorize({ method: "GET", url }, auth, region), signal });
}

/**
 * The region's chat models and inference profiles; doubles as the check of the
 * key or credentials. Credentials that may call models but not list them leave
 * the listing empty, and the save check's one-token chat decides.
 */
export async function listModels(baseURL: string, auth: Auth, signal: AbortSignal): Promise<ModelListing> {
  const region = regionOf(baseURL);
  try {
    const listed = await control("/foundation-models?byOutputModality=TEXT", auth, region, signal);
    if (listed.status === 403 && /AccessDenied/i.test(listed.headers.get("x-amzn-errortype") ?? "")) return { ok: true, models: null };
    if (!listed.ok) return { ok: false, status: listed.status, detail: await failure(listed) };
    const { modelSummaries = [] } = (await listed.json()) as { modelSummaries?: FoundationModel[] };
    const profiles: InferenceProfile[] = [];
    let next = "";
    for (let page = 0; page < 10; page += 1) {
      const res = await control(`/inference-profiles?maxResults=1000&type=SYSTEM_DEFINED${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`, auth, region, signal);
      // profiles only add the cross-region ids; the region's own models stand without them
      if (!res.ok) break;
      const body = (await res.json()) as { inferenceProfileSummaries?: InferenceProfile[]; nextToken?: string };
      profiles.push(...(body.inferenceProfileSummaries ?? []));
      next = body.nextToken ?? "";
      if (!next) break;
    }
    const { models, capabilities } = chatModels(modelSummaries, profiles);
    return { ok: true, models: models.length ? models : null, capabilities };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const VENDORS = ["anthropic", "amazon", "openai", "deepseek", "qwen", "mistral", "meta", "moonshotai", "zai", "xai"];
const vendorOf = (id: string): string => id.replace(/^[a-z-]+\.(?=[a-z]+\.)/, "").split(".")[0] ?? "";
const scopeOf = (id: string): number => (id.startsWith("global.") ? 0 : /^[a-z-]+\.[a-z]+\./.test(id) ? 1 : 2);
const rankOf = (vendor: string): number => {
  const at = VENDORS.indexOf(vendor);
  return at < 0 ? VENDORS.length : at;
};

/** Claude first, then Amazon's and the others'; within a vendor the newest first, and a model's global profile before its regional ones. */
export function usable(listed: string[]): string[] {
  const bare = (id: string) => id.replace(/^[a-z-]+\.(?=[a-z]+\.)/, "");
  return [...new Set(listed)].sort(
    (a, b) => rankOf(vendorOf(a)) - rankOf(vendorOf(b)) || bare(b).localeCompare(bare(a), "en", { numeric: true }) || scopeOf(a) - scopeOf(b) || a.localeCompare(b)
  );
}

/** A model's media: what the listing says, else Claude's and Nova's from their ids. */
export const media = (model: string, listed?: ModelMedia): ModelMedia | undefined => listed ?? mediaOf(model, /(^|\.)(anthropic\.claude|amazon\.nova)/.test(model) ? ["TEXT", "IMAGE"] : []);
