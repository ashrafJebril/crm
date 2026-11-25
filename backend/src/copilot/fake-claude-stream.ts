/**
 * SP-18 spec helper (not a runtime file): a scripted fake of the SDK's
 * `beta.messages.stream()` for ClaudeService. Each call takes the next step
 * of the script (the last one repeats): a reply (content blocks, stop
 * reason, usage), an Error to reject with, or a function of the request.
 * The stream yields SSE-like events (`content_block_delta` text deltas,
 * `input_json_delta` tool inputs) and `finalMessage()` resolves the message.
 * Every request is recorded (a deep copy, as sent). Nothing reaches a network.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ClaudeClientFactory } from "../ai/claude.service";

export interface ScriptedReply {
  content?: any[];
  stop_reason?: string;
  usage?: Record<string, number>;
  /** Wait this long before the first event (honours the abort signal). */
  delayMs?: number;
  /** Never answer until the request is aborted. */
  hang?: boolean;
}
export type ScriptStep = ScriptedReply | Error | ((params: any) => ScriptedReply | Error);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

function eventsOf(msg: any): any[] {
  const ev: any[] = [{ type: "message_start", message: { ...msg, content: [], stop_reason: null } }];
  msg.content.forEach((b: any, index: number) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      const words = String(b.text).match(/\S+\s*|\s+/g) ?? [];
      for (const w of words) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: w } });
      ev.push({ type: "content_block_stop", index });
    } else if (b.type === "tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
      ev.push({ type: "content_block_stop", index });
    } else {
      ev.push({ type: "content_block_start", index, content_block: b });
      ev.push({ type: "content_block_stop", index });
    }
  });
  ev.push({ type: "message_delta", delta: { stop_reason: msg.stop_reason }, usage: { output_tokens: msg.usage.output_tokens } });
  ev.push({ type: "message_stop" });
  return ev;
}

export function fakeClaudeStream(script: ScriptStep[], opts: { title?: string | Error } = {}) {
  const titleCalls: any[] = [];
  const create = jest.fn(async (params: any) => {
    titleCalls.push(JSON.parse(JSON.stringify(params)));
    if (opts.title instanceof Error) throw opts.title;
    return { id: "msg_title", type: "message", role: "assistant", model: params.model, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify({ title: opts.title ?? "A chat" }) }] };
  });
  const calls: any[] = [];
  const options: any[] = [];
  let n = 0;
  const stream = jest.fn((params: any, opts?: { signal?: AbortSignal }) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    options.push(opts);
    const step = script[Math.min(n++, script.length - 1)];
    const resolved = typeof step === "function" ? step(params) : step;
    const signal = opts?.signal;
    let done: Promise<any> | null = null;
    const run = async (): Promise<{ msg: any; events: any[] }> => {
      if (resolved instanceof Error) throw resolved;
      if (resolved.hang) {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (resolved.delayMs) await sleep(resolved.delayMs, signal);
      const msg = {
        id: `msg_${n}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content: resolved.content ?? [],
        stop_reason: resolved.stop_reason ?? "end_turn",
        stop_details: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(resolved.usage ?? {}) },
      };
      return { msg, events: eventsOf(msg) };
    };
    const get = () => (done ??= run());
    return {
      async *[Symbol.asyncIterator]() {
        const { events } = await get();
        for (const e of events) yield e;
      },
      finalMessage: async () => (await get()).msg,
    };
  });
  const factory: ClaudeClientFactory & jest.Mock = jest.fn(() => ({ beta: { messages: { stream, create } } }) as never) as never;
  return { factory, stream, create, calls, options, titleCalls };
}

export const text = (t: string) => ({ type: "text", text: t });
export const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
