/**
 * SP-21 spec helper (not a runtime file): a fake Anthropic SDK client for
 * ClaudeService. It records every request and never reaches the network.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type Anthropic from "@anthropic-ai/sdk";
import type { ClaudeClientFactory } from "./claude.service";

export function fakeClaude(reply: Partial<Anthropic.Beta.BetaMessage> | Error | ((params: any) => any)) {
  const calls: any[] = [];
  const create = jest.fn(async (params: any) => {
    calls.push(params);
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(params);
    return { id: "msg_1", type: "message", role: "assistant", model: params.model, content: [], stop_reason: "end_turn", ...reply };
  });
  // Streaming answers with the same reply: `finalMessage()` resolves (or rejects) with it.
  const stream = jest.fn((params: any, _options?: any) => ({ finalMessage: () => create(params) }));
  const factory: ClaudeClientFactory & jest.Mock = jest.fn(() => ({ beta: { messages: { create, stream } } }) as never) as never;
  return { factory, create, stream, calls };
}

