import type { ModelChatEvent, ModelChatRequest } from "@tomradex/plugin-sdk";

type Block = Record<string, unknown>;

/** Claude 5.x and Opus 4.6+ think adaptively and take an effort instead of a thinking budget. */
export const adaptive = (model: string): boolean => /^claude-(opus-4-[6-9]|(opus|sonnet|haiku|fable|mythos)-[5-9])/.test(model);

/** The app's effort as Claude's: it has no "minimal". */
const effortOf = (effort: string): string => (effort === "minimal" || effort === "off" ? "low" : effort);

/** Room for an answer; Claude's adaptive thinking spends from the same allowance. */
const MAX_TOKENS = 32_000;

/** Dynamic filtering needs Opus or Sonnet 4.6 or later; other models get the basic search. */
const FILTERING = /^claude-(opus|sonnet)-(4-[6-9]|[5-9])/;
export const searchTool = (model: string): Block => ({ type: FILTERING.test(model) ? "web_search_20260209" : "web_search_20250305", name: "web_search" });

/** What Claude wrote in an assistant turn, kept when it thought or searched, so the next request of the turn sends it back as written. */
const writtenOf = (provider: string, content: ModelChatRequest["messages"][number]["content"]): Block[] | undefined => {
  const native = content.find((b) => b.type === "native" && b.provider === provider);
  return native?.type === "native" ? (native.data as Block[]) : undefined;
};

/** The conversation as Messages API turns: tool results first in a user turn, turns of one role merged. */
export function toMessages(request: ModelChatRequest, provider: string): { role: "user" | "assistant"; content: Block[] }[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const message of request.messages) {
    const content =
      (message.role === "assistant" ? writtenOf(provider, message.content) : undefined) ??
      [
        ...message.content.flatMap((b): Block[] => (b.type === "tool_result" ? [{ type: "tool_result", tool_use_id: b.id, content: b.content, ...(b.isError ? { is_error: true } : {}) }] : [])),
        ...message.content.flatMap((b): Block[] => {
          if (b.type === "text") return b.text.trim() ? [{ type: "text", text: b.text }] : [];
          if (b.type === "media") return [{ type: b.media.mime === "application/pdf" ? "document" : "image", source: { type: "base64", media_type: b.media.mime, data: b.media.base64 } }];
          if (b.type === "tool_call") return [{ type: "tool_use", id: b.id, name: b.name, input: b.args ?? {} }];
          return [];
        })
      ];
    if (!content.length) continue;
    const last = out[out.length - 1];
    if (last?.role === message.role) last.content.push(...content);
    else out.push({ role: message.role, content: [...content] });
  }
  return out;
}

/** A Messages API body as Vertex takes it: no `model` (the URL names it), its own `anthropic_version`. */
export function claudeBody(model: string, request: ModelChatRequest, options: { provider: string; search: boolean; effort: boolean }, messages = toMessages(request, options.provider)): Block {
  const choice = request.toolChoice;
  const tools: Block[] = [
    ...(request.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    ...(options.search ? [searchTool(model)] : [])
  ];
  return {
    anthropic_version: "vertex-2023-10-16",
    stream: true,
    max_tokens: request.maxTokens ?? MAX_TOKENS,
    // the stable prefix ends at the system block; the conversation varies after it
    ...(request.system ? { system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] } : {}),
    messages,
    ...(tools.length ? { tools, ...(choice ? { tool_choice: typeof choice === "string" ? { type: choice } : { type: "tool", name: choice.name } } : {}) } : {}),
    ...(options.effort && request.effort && adaptive(model) ? { output_config: { effort: effortOf(request.effort) } } : {})
  };
}

interface ClaudeEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } };
  content_block?: Block;
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; citation?: { type?: string; url?: string; title?: string }; stop_reason?: string | null };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

const stopOf = (reason: string | null | undefined): "end" | "tool_use" | "max_tokens" | "refusal" =>
  reason === "tool_use" ? "tool_use" : reason === "max_tokens" || reason === "model_context_window_exceeded" ? "max_tokens" : reason === "refusal" ? "refusal" : "end";

export interface ClaudeTurn {
  /** Every block Claude wrote, as it wrote it. */
  written: Block[];
  /** The server paused a long search; sending back what it wrote resumes it. */
  paused: boolean;
  stop: ReturnType<typeof stopOf>;
}

/**
 * One streamed Messages reply as chat events: text as it comes, tool calls once
 * whole, usage counting every prompt token read. The blocks it wrote, thinking
 * and server tool results included, are returned for the caller to keep.
 */
export async function* readClaude(data: AsyncIterable<string>, sources: Map<string, string>): AsyncGenerator<ModelChatEvent, ClaudeTurn> {
  const open = new Map<number, { block: Block; json: string }>();
  const written: Block[] = [];
  let stop: ReturnType<typeof stopOf> = "end";
  let paused = false;
  for await (const raw of data) {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(raw) as ClaudeEvent;
    } catch {
      continue;
    }
    if (event.type === "message_start") {
      const u = event.message?.usage ?? {};
      const read = u.cache_read_input_tokens ?? undefined;
      const write = u.cache_creation_input_tokens ?? undefined;
      yield { type: "usage", inputTokens: (u.input_tokens ?? 0) + (read ?? 0) + (write ?? 0), ...(read != null ? { cacheReadTokens: read } : {}), ...(write != null ? { cacheWriteTokens: write } : {}) };
    } else if (event.type === "content_block_start" && event.content_block) {
      open.set(event.index ?? 0, { block: { ...event.content_block }, json: "" });
    } else if (event.type === "content_block_delta") {
      const slot = open.get(event.index ?? 0);
      const delta = event.delta ?? {};
      if (delta.type === "text_delta" && delta.text) {
        if (slot) slot.block.text = String(slot.block.text ?? "") + delta.text;
        yield { type: "text", delta: delta.text };
      } else if (delta.type === "input_json_delta" && slot) slot.json += delta.partial_json ?? "";
      else if (delta.type === "thinking_delta" && slot) slot.block.thinking = String(slot.block.thinking ?? "") + (delta.thinking ?? "");
      else if (delta.type === "signature_delta" && slot) slot.block.signature = delta.signature;
      else if (delta.type === "citations_delta" && slot && delta.citation) {
        slot.block.citations = [...((slot.block.citations as unknown[] | null) ?? []), delta.citation];
        const c = delta.citation;
        if (c.type === "web_search_result_location" && c.url && !sources.has(c.url)) sources.set(c.url, c.title || c.url);
      }
    } else if (event.type === "content_block_stop") {
      const slot = open.get(event.index ?? 0);
      if (!slot) continue;
      open.delete(event.index ?? 0);
      if (slot.block.type === "tool_use" || slot.block.type === "server_tool_use") {
        let args: unknown = {};
        try {
          args = slot.json ? JSON.parse(slot.json) : (slot.block.input ?? {});
        } catch {
          args = { __raw: slot.json };
        }
        slot.block.input = args;
        if (slot.block.type === "tool_use") yield { type: "tool_call", id: String(slot.block.id), name: String(slot.block.name), args };
      }
      written.push(slot.block);
    } else if (event.type === "message_delta") {
      if (event.usage?.output_tokens !== undefined) yield { type: "usage", outputTokens: event.usage.output_tokens };
      paused = event.delta?.stop_reason === "pause_turn";
      stop = stopOf(event.delta?.stop_reason);
    } else if (event.type === "error") {
      throw new Error(`Claude on Vertex: ${event.error?.type ?? "error"}: ${event.error?.message ?? ""}`);
    }
  }
  return { written, paused, stop };
}

/** Whether a turn's blocks must go back as written: Claude thought, or searched on the server. */
export const keeps = (written: Block[]): boolean => written.some((b) => b.type === "thinking" || b.type === "redacted_thinking" || b.type === "server_tool_use");
