import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";

export type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown; id?: string };
};
type Content = { role: "user" | "model"; parts: Part[] };
type Message = ModelChatRequest["messages"][number];

/** Gemini 3 and later: thinking levels, thought signatures, and the default temperature Google asks to keep. */
export const modern = (model: string): boolean => /^gemini-([3-9]|\d{2,})/.test(model);

const LEVELS: Record<string, string> = { minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH" };

/** The app's effort as a thinking level. Gemini 3.8 Flash has no MINIMAL, so the least asked for is LOW. */
export const levelOf = (effort: string): string => LEVELS[effort] ?? (/x?high|max/.test(effort) ? "HIGH" : "LOW");

/** What Google lets a function call another model wrote carry through Gemini 3's signature check. */
export const UNSIGNED = "skip_thought_signature_validator";

/** The parts of a model turn as Gemini wrote them, kept so its thought signatures go back with the calls they led to. */
const writtenOf = (provider: string, content: Message["content"]): Part[] | undefined => {
  const native = content.find((b) => b.type === "native" && b.provider === provider);
  return native?.type === "native" ? (native.data as Part[]) : undefined;
};

/** The person's last message that is not tool results: the turn Gemini checks signatures in starts there. */
const turnStart = (messages: Message[]): number => {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const m = messages[at]!;
    if (m.role === "user" && m.content.some((b) => b.type === "text" || b.type === "media")) return at;
  }
  return -1;
};

/** A tool's JSON Schema for `parametersJsonSchema`, which takes it whole (`additionalProperties` included); the dialect line stays out. */
const schemaOf = (schema: Record<string, unknown>): Record<string, unknown> => {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
};

export interface GeminiOptions {
  /** The plugin's namespace, under which Gemini's own turns are kept between the requests of a turn. */
  provider: string;
  /** Ground the answer with Google Search. */
  search: boolean;
  /** Send a thinking level for the request's effort. */
  thinking: boolean;
}

/**
 * The request as a generateContent body: turns as contents, tool results as
 * function responses named after the calls they answer, media inline, and the
 * model's own turns as it wrote them.
 */
export function toGemini(model: string, request: ModelChatRequest, options: GeminiOptions): Record<string, unknown> {
  const names = new Map<string, string>();
  // ids Gemini gave its calls, which its responses must name again
  const given = new Set<string>();
  const start = turnStart(request.messages);
  const contents: Content[] = [];
  request.messages.forEach((message, at) => {
    let parts: Part[];
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "tool_call") names.set(block.id, block.name);
      const written = writtenOf(options.provider, message.content);
      if (written) {
        for (const part of written) if (part.functionCall?.id) given.add(part.functionCall.id);
        parts = written.map((part) => ({ ...part }));
      } else {
        parts = message.content.flatMap((block): Part[] => {
          if (block.type === "text") return block.text ? [{ text: block.text }] : [];
          if (block.type === "tool_call") return [{ functionCall: { name: block.name, args: block.args ?? {} } }];
          return [];
        });
        // another model's calls in this turn carry no signature, which Gemini 3 asks for on a step's first call
        const first = parts.find((part) => part.functionCall);
        if (first && at > start && modern(model)) first.thoughtSignature = UNSIGNED;
      }
    } else {
      parts = [
        ...message.content.flatMap((block): Part[] =>
          block.type === "tool_result"
            ? [{ functionResponse: { name: names.get(block.id) ?? block.id, ...(given.has(block.id) ? { id: block.id } : {}), response: block.isError ? { error: block.content } : { output: block.content } } }]
            : []
        ),
        ...message.content.flatMap((block): Part[] => {
          if (block.type === "text") return block.text.trim() ? [{ text: block.text }] : [];
          if (block.type === "media") return [{ inlineData: { mimeType: block.media.mime, data: block.media.base64 } }];
          return [];
        })
      ];
    }
    if (!parts.length) return;
    const role = message.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  });

  const functions = (request.tools ?? []).map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: schemaOf(t.inputSchema) }));
  const tools: Record<string, unknown>[] = functions.length ? [{ functionDeclarations: functions }] : [];
  // Vertex takes Google Search beside other search tools only, never beside functions
  if (options.search && !functions.length) tools.push({ googleSearch: {} });
  const choice = request.toolChoice;
  const config = {
    ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
    // Google asks Gemini 3 to keep its default temperature: lower ones make it loop
    ...(request.temperature !== undefined && !modern(model) ? { temperature: request.temperature } : {}),
    ...(request.json ? { responseMimeType: "application/json" } : {}),
    ...(options.thinking && request.effort && modern(model) ? { thinkingConfig: { thinkingLevel: levelOf(request.effort) } } : {})
  };
  return {
    contents,
    ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
    ...(tools.length ? { tools } : {}),
    ...(functions.length && choice
      ? { toolConfig: { functionCallingConfig: typeof choice === "string" ? { mode: choice === "none" ? "NONE" : "AUTO" } : { mode: "ANY", allowedFunctionNames: [choice.name] } } }
      : {}),
    ...(Object.keys(config).length ? { generationConfig: config } : {})
  };
}

/** The data lines of a server-sent event stream. */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) yield rest.slice(5).trim();
}

const REFUSED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "MODEL_ARMOR", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);
/** Ends that leave nothing to show: said as an error rather than an empty reply. */
const BROKEN = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]);

const stopOf = (reason: string): "end" | "max_tokens" | "refusal" => (reason === "MAX_TOKENS" ? "max_tokens" : REFUSED.has(reason) ? "refusal" : "end");

interface Chunk {
  candidates?: {
    content?: { parts?: Part[] };
    finishReason?: string;
    finishMessage?: string;
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; toolUsePromptTokenCount?: number; cachedContentTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

/** Gemini gives no call ids on Vertex; these stay unique across the requests of a conversation. */
const callIds = (): ((n: number) => string) => {
  const run = Math.random().toString(36).slice(2, 8);
  return (n) => `call_${run}_${n}`;
};

/**
 * A streamGenerateContent reply as chat events: text as it streams (thoughts
 * hidden), each function call as it arrives, the pages Google Search grounded
 * the answer in, usage, the stop. The turn's parts follow as `provider`'s own
 * record, so the next request of the turn carries their signatures back.
 */
export async function* readGemini(data: AsyncIterable<string>, provider: string, idOf = callIds()): AsyncGenerator<ModelChatEvent> {
  const written: Part[] = [];
  const sources = new Map<string, string>();
  let usage: Chunk["usageMetadata"];
  let finish = "";
  let detail = "";
  let calls = 0;
  let said = false;
  for await (const raw of data) {
    let chunk: Chunk;
    try {
      chunk = JSON.parse(raw) as Chunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(`Vertex AI ${chunk.error.status ?? chunk.error.code ?? "error"}: ${chunk.error.message ?? raw.slice(0, 300)}`);
    // every chunk carries the usage so far; the last one counts
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) finish = "PROHIBITED_CONTENT";
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall) {
        calls += 1;
        said = true;
        written.push(part);
        yield { type: "tool_call", id: part.functionCall.id || idOf(calls), name: part.functionCall.name ?? "", args: part.functionCall.args ?? {} };
      } else if (part.thought) {
        // a thought is not shown; a signature on it still goes back
        if (part.thoughtSignature) written.push({ text: "", thoughtSignature: part.thoughtSignature });
      } else if (typeof part.text === "string") {
        if (part.text) {
          said = true;
          yield { type: "text", delta: part.text };
        }
        const last = written[written.length - 1];
        // streamed pieces of one text join up, the signature that ends them with them
        if (last && typeof last.text === "string" && Object.keys(last).length === 1) {
          last.text += part.text;
          if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
        } else if (part.text || part.thoughtSignature) written.push({ text: part.text, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
      } else written.push(part);
    }
    for (const c of candidate.groundingMetadata?.groundingChunks ?? []) if (c.web?.uri && !sources.has(c.web.uri)) sources.set(c.web.uri, c.web.title || c.web.uri);
    if (candidate.finishReason) [finish, detail] = [candidate.finishReason, candidate.finishMessage ?? ""];
  }
  if (!said && BROKEN.has(finish)) throw new Error(`Vertex AI could not finish the reply (${finish}${detail ? `: ${detail}` : ""})`);
  if (sources.size) yield { type: "text", delta: "\n\n" + [...sources].map(([uri, title]) => `- [${title.replace(/[[\]]/g, "")}](${uri})`).join("\n") };
  if (usage) {
    yield {
      type: "usage",
      // the prompt count includes what the cache read; search results read in count as prompt too
      inputTokens: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
      // thinking is billed as output
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      ...(usage.cachedContentTokenCount != null ? { cacheReadTokens: usage.cachedContentTokenCount } : {})
    };
  }
  if (written.length) yield { type: "native", provider, data: written };
  yield { type: "stop", reason: calls ? "tool_use" : stopOf(finish) };
}
