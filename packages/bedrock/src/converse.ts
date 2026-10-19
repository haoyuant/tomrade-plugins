import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";
import { eventStream } from "./eventstream.js";

type Block = Record<string, unknown>;

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const DOCUMENT: Record<string, string> = { "application/pdf": "pdf", "text/csv": "csv", "text/html": "html", "text/plain": "txt", "text/markdown": "md" };

/** Converse takes a document name of letters, digits, spaces, hyphens, parentheses and brackets, without two spaces in a row. */
const documentName = (name: string): string =>
  name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9\s\-()[\]]/g, " ").replace(/\s+/g, " ").trim() || "document";

/** Claude, by model or inference profile id (`global.anthropic.claude-…`). */
export const claude = (model: string): boolean => /(^|\.)anthropic\.claude/.test(model);

/** Prompt caching on the models that have it: Claude and Nova. */
export const caches = (model: string): boolean => claude(model) || /(^|\.)amazon\.nova/.test(model);

/** The Claude models that think adaptively and take an effort, rather than a thinking budget. */
export const adaptive = (model: string): boolean => /(^|\.)anthropic\.claude-(opus-4-[6-9]|(opus|sonnet|haiku|fable|mythos)-[5-9])/.test(model);

/** The app's effort as Claude's: it has no "minimal". */
export const effortOf = (effort: string): string => (effort === "minimal" || effort === "off" ? "low" : effort);

/** Room for an answer Claude must be given; its adaptive thinking spends from the same allowance. */
const CLAUDE_MAX_TOKENS = 32_000;

/** The blocks of an assistant turn as Bedrock wrote them, kept when Claude reasoned, so its signed thinking goes back with the tool calls it led to. */
const writtenOf = (provider: string, content: ModelChatRequest["messages"][number]["content"]): Block[] | undefined => {
  const native = content.find((b) => b.type === "native" && b.provider === provider);
  return native?.type === "native" ? (native.data as Block[]) : undefined;
};

/**
 * The request as a ConverseStream body: each turn's text, media, tool calls and
 * results as content blocks, turns of one role merged, as Converse wants them alternating.
 */
export function toConverse(model: string, request: ModelChatRequest, options: { provider: string; effort?: boolean }): Block {
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const message of request.messages) {
    const content =
      (message.role === "assistant" ? writtenOf(options.provider, message.content) : undefined) ??
      message.content.flatMap((block): Block[] => {
        if (block.type === "text") return block.text.trim() ? [{ text: block.text }] : [];
        if (block.type === "media") {
          const { mime, base64, name } = block.media;
          if (IMAGE.test(mime)) return [{ image: { format: mime.slice(6), source: { bytes: base64 } } }];
          const format = DOCUMENT[mime];
          return format ? [{ document: { format, name: documentName(name), source: { bytes: base64 } } }] : [];
        }
        if (block.type === "tool_call") return [{ toolUse: { toolUseId: block.id, name: block.name, input: block.args ?? {} } }];
        if (block.type === "tool_result") return [{ toolResult: { toolUseId: block.id, content: [{ text: block.content || "(empty)" }], ...(block.isError ? { status: "error" } : {}) } }];
        return [];
      });
    if (!content.length) continue;
    const last = messages[messages.length - 1];
    if (last?.role === message.role) last.content.push(...content);
    else messages.push({ role: message.role, content: [...content] });
  }

  const choice = request.toolChoice;
  const tools = (request.tools ?? []).map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } } }));
  const called = [...new Set(request.messages.flatMap((m) => m.content.flatMap((b) => (b.type === "tool_call" ? [b.name] : []))))];
  const maxTokens = request.maxTokens ?? (claude(model) ? CLAUDE_MAX_TOKENS : undefined);
  const body: Block = {
    messages,
    ...(request.system ? { system: [{ text: request.system }, ...(caches(model) ? [{ cachePoint: { type: "default" } }] : [])] } : {}),
    inferenceConfig: {
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      // Claude thinks by default on Bedrock, and a thinking model takes only its own temperature
      ...(request.temperature !== undefined && !claude(model) ? { temperature: request.temperature } : {})
    }
  };
  if (tools.length) {
    // Converse has no "none": the tools stay declared and the model is left to choose
    const forced = choice && choice !== "none" && choice !== "auto" ? (typeof choice === "string" ? { any: {} } : { tool: { name: choice.name } }) : null;
    body.toolConfig = { tools, ...(forced ? { toolChoice: forced } : {}) };
  } else if (called.length) {
    // a conversation that used tools must still declare them, even on a turn that offers none
    body.toolConfig = { tools: called.map((name) => ({ toolSpec: { name, description: name, inputSchema: { json: { type: "object" } } } })) };
  }
  if (options.effort && request.effort && adaptive(model)) body.additionalModelRequestFields = { output_config: { effort: effortOf(request.effort) } };
  return body;
}

const stopOf = (reason: string | undefined): "end" | "tool_use" | "max_tokens" | "refusal" =>
  reason === "tool_use" ? "tool_use" : reason === "max_tokens" || reason === "model_context_window_exceeded" ? "max_tokens" : reason === "guardrail_intervened" || reason === "content_filtered" ? "refusal" : "end";

interface ConverseEvent {
  contentBlockIndex?: number;
  start?: { toolUse?: { toolUseId: string; name: string } };
  delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string; signature?: string; redactedContent?: string } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  message?: string;
  Message?: string;
}

/**
 * A ConverseStream reply as chat events: text as it streams, each tool call
 * once its input is whole, usage, the stop. When the model reasoned, the turn's
 * blocks follow as `provider`'s own record for the next request of the turn.
 */
export async function* readConverse(body: AsyncIterable<Uint8Array>, provider: string): AsyncGenerator<ModelChatEvent> {
  const decoder = new TextDecoder();
  const written = new Map<number, Block>();
  const inputs = new Map<number, string>();
  let reasoned = false;
  let stop: ReturnType<typeof stopOf> = "end";
  for await (const message of eventStream(body)) {
    const kind = message.headers[":message-type"];
    const type = message.headers[":event-type"] ?? message.headers[":exception-type"] ?? "";
    const raw = decoder.decode(message.payload);
    let event: ConverseEvent = {};
    try {
      event = JSON.parse(raw || "{}") as ConverseEvent;
    } catch {
      if (kind === "event") continue;
    }
    if (kind === "exception" || kind === "error") throw new Error(`Bedrock ${type || message.headers[":error-code"] || "error"}: ${event.message ?? event.Message ?? message.headers[":error-message"] ?? raw.slice(0, 300)}`);
    const index = event.contentBlockIndex ?? 0;
    if (type === "contentBlockStart" && event.start?.toolUse) {
      written.set(index, { toolUse: { toolUseId: event.start.toolUse.toolUseId, name: event.start.toolUse.name, input: {} } });
      inputs.set(index, "");
    } else if (type === "contentBlockDelta") {
      const delta = event.delta ?? {};
      if (delta.text) {
        yield { type: "text", delta: delta.text };
        const block = written.get(index) ?? { text: "" };
        block.text = String(block.text ?? "") + delta.text;
        written.set(index, block);
      }
      if (delta.toolUse?.input) inputs.set(index, (inputs.get(index) ?? "") + delta.toolUse.input);
      if (delta.reasoningContent) {
        reasoned = true;
        const block = written.get(index) ?? { reasoningContent: {} };
        const reasoning = block.reasoningContent as { reasoningText?: { text: string; signature?: string }; redactedContent?: string };
        if (delta.reasoningContent.redactedContent) reasoning.redactedContent = delta.reasoningContent.redactedContent;
        if (delta.reasoningContent.text !== undefined || delta.reasoningContent.signature) {
          reasoning.reasoningText ??= { text: "" };
          reasoning.reasoningText.text += delta.reasoningContent.text ?? "";
          if (delta.reasoningContent.signature) reasoning.reasoningText.signature = delta.reasoningContent.signature;
        }
        written.set(index, block);
      }
    } else if (type === "contentBlockStop") {
      const block = written.get(index);
      const use = block?.toolUse as { toolUseId: string; name: string; input: unknown } | undefined;
      if (!use) continue;
      const json = inputs.get(index) ?? "";
      try {
        use.input = json ? JSON.parse(json) : {};
      } catch {
        use.input = { __raw: json };
      }
      yield { type: "tool_call", id: use.toolUseId, name: use.name, args: use.input };
    } else if (type === "messageStop") stop = stopOf(event.stopReason);
    else if (type === "metadata" && event.usage) {
      const u = event.usage;
      // Converse's inputTokens leaves out what the cache read and wrote; Tomrade counts every prompt token read
      const read = u.cacheReadInputTokens ?? 0;
      const write = u.cacheWriteInputTokens ?? 0;
      yield {
        type: "usage",
        inputTokens: (u.inputTokens ?? 0) + read + write,
        outputTokens: u.outputTokens,
        ...(u.cacheReadInputTokens != null ? { cacheReadTokens: read } : {}),
        ...(u.cacheWriteInputTokens != null ? { cacheWriteTokens: write } : {})
      };
    }
  }
  if (reasoned) yield { type: "native", provider, data: [...written.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) };
  yield { type: "stop", reason: stop };
}
