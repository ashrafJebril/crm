import { describe, expect, it } from "vitest";
import { createSseParser, STREAM_LOST, type SseFrame } from "./eventStream";
import { createEventReader } from "./client";

const collect = (chunks: string[]) => {
  const out: SseFrame[] = [];
  const p = createSseParser((f) => out.push(f));
  for (const c of chunks) p.push(c);
  p.end();
  return out;
};

describe("event stream parser handles split chunks and ends with an error when cut", () => {
  it("frames split anywhere, CRLF, multi-line data, comments and heartbeats", () => {
    const whole = 'event: session\ndata: {"sessionId":"s1","title":null}\n\n:\n\nevent: token\ndata: {"text":"Hel"}\n\nevent: token\r\ndata: {"text":"lo"}\r\n\r\n: keep-alive\n\nevent: note\ndata: line one\ndata: line two\n\n';
    const expected = [
      { event: "session", data: '{"sessionId":"s1","title":null}' },
      { event: "token", data: '{"text":"Hel"}' },
      { event: "token", data: '{"text":"lo"}' },
      { event: "note", data: "line one\nline two" },
    ];
    expect(collect([whole])).toEqual(expected);
    // Every split point gives the same frames.
    for (let i = 1; i < whole.length; i++) expect(collect([whole.slice(0, i), whole.slice(i)])).toEqual(expected);
    // One character at a time.
    expect(collect(whole.split(""))).toEqual(expected);
  });

  it("a frame without data, or cut by the end of the stream, is dropped", () => {
    expect(collect(["event: ping\n\n", 'event: token\ndata: {"text":"x"}'])).toEqual([]);
  });

  it("the reader stops at the first terminal event and parses JSON", () => {
    const seen: [string, unknown][] = [];
    const r = createEventReader((e, d) => seen.push([e, d]));
    r.push('event: token\ndata: {"text":"a"}\n\nevent: done\ndata: {"messageId":"m1"}\n\nevent: token\ndata: {"text":"late"}\n\n');
    expect(r.end()).toBe("done");
    expect(seen).toEqual([
      ["token", { text: "a" }],
      ["done", { messageId: "m1" }],
    ]);
  });

  it("a stream cut before done or error ends with a synthetic error", () => {
    const seen: [string, unknown][] = [];
    const r = createEventReader((e, d) => seen.push([e, d]));
    r.push('event: session\ndata: {"sessionId":"s1"}\n\nevent: token\ndata: {"te');
    expect(r.end()).toBe("error");
    expect(seen).toEqual([
      ["session", { sessionId: "s1" }],
      ["error", { code: STREAM_LOST }],
    ]);
    // A server error event is terminal too (no synthetic one added).
    const seen2: string[] = [];
    const r2 = createEventReader((e) => seen2.push(e));
    r2.push('event: error\ndata: {"code":"copilot.refused"}\n\n');
    expect(r2.end()).toBe("error");
    expect(seen2).toEqual(["error"]);
  });
});

describe("postEventStream session expiry (SP-26 token-guarded path)", () => {
  it("a 401 for the current token signs out with the server's reason, before any event", async () => {
    const { api, setUnauthorizedHandler, tokenStore, ApiError } = await import("./client");
    const realFetch = globalThis.fetch;
    const seen: (string | undefined)[] = [];
    setUnauthorizedHandler((r) => seen.push(r));
    tokenStore.set("tok-1");
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ statusCode: 401, message: "auth.session_expired" }), { status: 401 })) as typeof fetch;
      const events: string[] = [];
      await expect(api.postEventStream("/copilot/stream", {}, { onEvent: (e) => events.push(e) })).rejects.toBeInstanceOf(ApiError);
      expect(seen).toEqual(["auth.session_expired"]);
      expect(events).toEqual([]);
      // A 401 without a message still names the reason.
      globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
      await expect(api.postEventStream("/copilot/stream", {}, { onEvent: () => undefined })).rejects.toBeInstanceOf(ApiError);
      expect(seen[seen.length - 1]).toBe("auth.session_expired");
    } finally {
      globalThis.fetch = realFetch;
      setUnauthorizedHandler(null);
      tokenStore.clear();
    }
  });
});
