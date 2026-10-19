import type { ModelListing, ModelMedia, ModelPresetSpec } from "@tomradex/plugin-sdk";

/** La Plateforme, Mistral's own API. */
export const MISTRAL = "https://api.mistral.ai/v1";

export const PRESETS: ModelPresetSpec[] = [
  {
    id: "mistral",
    title: "Mistral AI",
    baseURL: MISTRAL,
    // GA and built for agents and code
    model: "mistral-medium-3-5",
    keyPage: "https://console.mistral.ai/api-keys",
    env: "MISTRAL_API_KEY",
    hint: { en: "La Plateforme, Mistral's own API, served from the EU", zh: "Mistral 自己的 API 平台 La Plateforme，服务器在欧盟" }
  }
];

/** One card of `GET /models`. Each name of a model, its aliases too, has a card of its own. */
interface Card {
  id?: string;
  aliases?: string[];
  capabilities?: { completion_chat?: boolean; function_calling?: boolean; vision?: boolean };
  deprecation?: string | null;
}

/** Embeddings, OCR, moderation and speech, should one of them call itself a chat model. */
const NOT_CHAT = /embed|ocr|moderation|voxtral|tts|transcribe/i;

const read = (image: boolean): ModelMedia => ({ inputModalities: image ? ["image"] : [], outputModalities: [] });

/** A moving `-latest` alias only when nothing else names the model; otherwise the longest, most specific name. */
const specific = (a: string, b: string): number => Number(a.endsWith("-latest")) - Number(b.endsWith("-latest")) || b.length - a.length || a.localeCompare(b);

/** The models the assistant can run on: chat models that call tools and are not yet deprecated, each once, with whether it reads pictures. */
export function chatModels(cards: Card[], now = Date.now()): { models: string[]; capabilities: Record<string, ModelMedia> } {
  const groups: { names: Set<string>; ids: string[]; vision: boolean }[] = [];
  for (const card of cards) {
    const can = card.capabilities ?? {};
    if (!card.id || !can.completion_chat || !can.function_calling || NOT_CHAT.test(card.id)) continue;
    if (card.deprecation && Date.parse(card.deprecation) <= now) continue;
    const names = [card.id, ...(card.aliases ?? [])];
    let group = groups.find((g) => names.some((name) => g.names.has(name)));
    if (!group) groups.push((group = { names: new Set(), ids: [], vision: false }));
    for (const name of names) group.names.add(name);
    group.ids.push(card.id);
    group.vision ||= !!can.vision;
  }
  const models = groups.map((g) => g.ids.sort(specific)[0]!);
  return { models, capabilities: Object.fromEntries(groups.map((g, i) => [models[i], read(g.vision)])) };
}

/** Mistral's `GET /models`, read here: the app's own listing reads none of its cards' chat, tools, vision or deprecation fields. */
export async function listing(endpoint: { baseURL?: string; apiKey: string }, signal: AbortSignal): Promise<ModelListing> {
  const res = await fetch(`${(endpoint.baseURL || MISTRAL).replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${endpoint.apiKey}` }, signal });
  // a gateway in the profile's address may have no listing; the profile then starts on the preset's model
  if (res.status === 404 || res.status === 405) return { ok: true, models: null };
  const text = await res.text();
  if (!res.ok) return { ok: false, status: res.status, detail: `${res.status} ${text.slice(0, 300)}` };
  return { ok: true, ...chatModels((JSON.parse(text) as { data?: Card[] }).data ?? []) };
}

/** Large, Medium, Small and Ministral 3 read pictures: for a name the listing does not show, such as an alias. */
export function media(model: string, listed?: ModelMedia): ModelMedia | undefined {
  if (listed) return listed;
  return /^(mistral-(large|medium|small)-|ministral-\d+b-(2512|latest)$)/i.test(model) ? read(true) : undefined;
}

/** Medium 3.5, Large 4 and Small 4 take `reasoning_effort`, under any of their names; Mistral's other models may refuse it. */
const REASONS = /^mistral-(medium-(3-5|3|latest)|small-(2603|latest))$|^mistral-large-4(-|$)/i;

/** The app's efforts as Mistral's enum has them. */
const EFFORT = new Map([["off", "none"], ["none", "none"], ["minimal", "minimal"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "xhigh"]]);

/** Every field of Mistral's chat/completions request. Its schema allows no other (`additionalProperties: false`) and has no `stream_options`. */
export const FIELDS = new Set([
  "model", "messages", "stream", "temperature", "top_p", "max_tokens", "min_tokens", "stop", "random_seed", "metadata",
  "response_format", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "repetition_penalty",
  "top_k", "logprobs", "top_logprobs", "prompt_logprobs", "top_prompt_logprobs", "n", "prediction", "reasoning_effort",
  "prompt_mode", "guardrails", "prompt_cache_key", "service_tier", "safe_prompt"
]);

/**
 * The chat/completions body as Mistral takes it: its own fields only, the
 * temperature in its 0–1.5, the effort only where the model reasons, and
 * tool-call ids it accepts.
 */
export function shape(model: string, json: Record<string, unknown>): Record<string, unknown> {
  const out = Object.fromEntries(Object.entries(json).filter(([field]) => FIELDS.has(field)));
  if (json.max_completion_tokens !== undefined && out.max_tokens === undefined) out.max_tokens = json.max_completion_tokens;
  if (typeof out.temperature === "number") out.temperature = Math.min(1.5, Math.max(0, out.temperature));
  const effort = EFFORT.get(String(out.reasoning_effort));
  if (effort && REASONS.test(model)) out.reasoning_effort = effort;
  else delete out.reasoning_effort;
  if (Array.isArray(out.messages)) out.messages = toolIds(out.messages as Message[]);
  return out;
}

type Message = { role?: string; tool_call_id?: unknown; tool_calls?: { id?: unknown; [field: string]: unknown }[]; [field: string]: unknown };

const ID = /^[a-zA-Z0-9]{9}$/;
const DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Nine letters and digits from a 53-bit hash of the id (cyrb53); another `salt` gives another. */
function nine(id: string, salt: number): string {
  let h1 = 0xdeadbeef ^ salt;
  let h2 = 0x41c6ce57 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  let n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  let out = "";
  for (let i = 0; i < 9; i += 1) {
    out += DIGITS[n % 62];
    n = Math.floor(n / 62);
  }
  return out;
}

/**
 * Mistral takes only tool-call ids of nine letters and digits. One another
 * provider made earlier in the thread gets such an id made from it, the same in
 * the call and its result and unlike any other in the request; Mistral's own stay.
 */
export function toolIds(messages: Message[]): Message[] {
  const taken = new Set<string>();
  for (const m of messages) {
    for (const id of [m.tool_call_id, ...(m.tool_calls ?? []).map((c) => c.id)]) if (typeof id === "string" && ID.test(id)) taken.add(id);
  }
  const made = new Map<string, string>();
  const rename = (id: unknown): unknown => {
    if (typeof id !== "string" || ID.test(id)) return id;
    if (!made.has(id)) {
      let next = nine(id, 0);
      for (let salt = 1; taken.has(next); salt += 1) next = nine(id, salt);
      taken.add(next);
      made.set(id, next);
    }
    return made.get(id);
  };
  return messages.map((m) => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) return { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, id: rename(c.id) })) };
    if (m.role === "tool" && m.tool_call_id !== undefined) return { ...m, tool_call_id: rename(m.tool_call_id) };
    return m;
  });
}
