/**
 * SP-18 request builder over SP-21's ClaudeService (claude-api skill rules):
 *
 *  - model `COPILOT_MODEL` (default `claude-opus-5-5`), `output_config.effort`
 *    "medium" set explicitly, `max_tokens` 64 000 on the streamed call;
 *  - `thinking` omitted (adaptive; `disabled` is a 400 on this model), no
 *    `temperature`, no prefill, `tool_choice` auto (forced choice is a 400);
 *  - tools from the registry: strict, `additionalProperties: false`,
 *    `eager_input_streaming: true`, sorted, the last with `cache_control`;
 *  - the stable system prompt as a cached block, and a top-level
 *    `cache_control` (automatic caching of the last block), so every loop
 *    call of a turn and the next turn read the history from the cache;
 *  - the server-side refusal fallback (`fallbacks: "default"`, beta
 *    `server-side-fallback-2026-07-01`) through `ClaudeService.baseRequest`.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeService } from "../ai/claude.service";
import { CHAT_MAX_TOKENS, COPILOT_MODEL_ENV } from "./copilot-constants";

/** Models that accept a mid-conversation `role: "system"` message (claude-api skill). */
export const SYSTEM_MESSAGE_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-mythos-5-2",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

export function copilotModel(claude: ClaudeService): string {
  return claude.model(COPILOT_MODEL_ENV);
}

export function buildChatRequest(
  claude: ClaudeService,
  input: { model: string; system: string; tools: Anthropic.Beta.BetaTool[]; messages: Anthropic.Beta.BetaMessageParam[] },
) {
  return {
    ...claude.baseRequest({ model: input.model, effort: "medium", maxTokens: CHAT_MAX_TOKENS }),
    system: [{ type: "text" as const, text: input.system, cache_control: { type: "ephemeral" as const } }],
    tools: input.tools,
    tool_choice: { type: "auto" as const },
    // The moving breakpoint: the last block of the conversation (≤ 4 breakpoints: tools, system, this).
    cache_control: { type: "ephemeral" as const },
    // A snapshot: the turn keeps appending to its own array.
    messages: [...input.messages],
  };
}

/** The per-turn context as a mid-conversation system message, or a user text block on models without them. */
export function contextMessage(model: string, context: string): { system?: Anthropic.Beta.BetaMessageParam; userBlock?: Anthropic.Beta.BetaTextBlockParam } {
  return SYSTEM_MESSAGE_MODELS.has(model)
    ? { system: { role: "system", content: context } }
    : { userBlock: { type: "text", text: `[Operator context]\n${context}` } };
}

const STOPPED_NOTE = "The turn stopped before this tool ran.";
export const NO_ANSWER = "(The turn stopped before an answer.)";

/**
 * Close a turn's transcript so it can be replayed: answer open tool calls
 * (is_error results) and end with an assistant message. A turn that already
 * ends with an assistant message without open tool calls is unchanged.
 */
export function closeTranscript(msgs: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  const out = [...msgs];
  const last = out[out.length - 1];
  if (last?.role === "assistant") {
    const open = Array.isArray(last.content) ? (last.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[]) : [];
    if (!open.length) return out;
    out.push({ role: "user", content: open.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, is_error: true, content: STOPPED_NOTE })) });
  }
  out.push({ role: "assistant", content: [{ type: "text", text: NO_ANSWER }] });
  return out;
}

/** Strip thinking blocks (used only when older turns are dropped from the replay, so no block is replayed out of its prefix). */
export function withoutThinking(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    return { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") };
  });
}
