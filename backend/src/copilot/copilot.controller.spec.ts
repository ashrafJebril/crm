/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from "events";
import { AGENT, OWNER, WS, copilotWorld, httpError, viewer, withKey } from "./copilot-test-world";
import { sseFrame } from "./copilot.controller";
import { text } from "./fake-claude-stream";

function fakeHttp() {
  const req = new EventEmitter();
  const writes: string[] = [];
  let closed = false;
  const res = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => {
      if (closed) throw new Error("write after end");
      writes.push(chunk);
      return true;
    }),
    end: jest.fn(),
  };
  const close = () => {
    closed = true;
    req.emit("close");
  };
  /** Parsed `event:`/`data:` frames. */
  const frames = () =>
    writes
      .join("")
      .split("\n\n")
      .filter((f) => f.startsWith("event: "))
      .map((f) => {
        const [e, d] = f.split("\n");
        return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
      });
  return { req, res, close, frames, writes };
}

const body = (extra: any = {}) => ({ message: "Hi", approvalMode: "manual", lang: "en", ...extra }) as any;

describe("CopilotController", () => {
  it("sseFrame: one named event, one JSON data line", () => {
    expect(sseFrame("token", { text: "a\nb" })).toBe('event: token\ndata: {"text":"a\\nb"}\n\n');
  });

  it("streams session first, then activity/token, and done last", async () => {
    const w = copilotWorld({ script: [{ content: [text("Hello there")] }] });
    const h = fakeHttp();
    await withKey(() => w.controller.stream(WS, viewer(OWNER), body(), h.req as any, h.res as any));
    expect(h.res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(h.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    const f = h.frames();
    expect(f[0]).toEqual({ event: "session", data: { sessionId: w.db.copilotSession[0].id, title: null } });
    expect(f.map((x) => x.event)).toEqual(["session", "activity", "token", "token", "done"]);
    expect(h.res.end).toHaveBeenCalled();
  });

  it("pre-flight refusals are plain HTTP errors (nothing streamed)", async () => {
    const w = copilotWorld();
    const h = fakeHttp();
    expect(await httpError(withKey(() => w.controller.stream(WS, viewer(OWNER), body({ message: "" }), h.req as any, h.res as any)))).toMatchObject({ status: 400 });
    expect(h.res.setHeader).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("turn outlives the client and is resumable", async () => {
    let h!: ReturnType<typeof fakeHttp>;
    const w = copilotWorld({
      script: [
        () => {
          // The member closes the tab while the model is answering.
          h.close();
          return { content: [text("The late answer")], delayMs: 20 };
        },
      ],
    });
    h = fakeHttp();
    let runningMidTurn: boolean | null = null;
    const spy = jest.spyOn(w.fake, "stream");
    spy.mockImplementationOnce(((...args: any[]) => {
      runningMidTurn = !!w.db.copilotSession[0]?.runningUntil;
      return (w.fake.stream.getMockImplementation() as any)(...args);
    }) as any);
    await withKey(() => w.controller.stream(WS, viewer(AGENT), body(), h.req as any, h.res as any));
    // Only what was written before the close reached the client; no write threw.
    expect(h.frames().map((x) => x.event)).toEqual(["session", "activity"]);
    // The turn finished and was persisted; the session is no longer running.
    const sessionId = w.db.copilotSession[0].id;
    expect(runningMidTurn).toBe(true);
    const d = await w.controller.get(WS, viewer(AGENT), sessionId);
    expect(d.running).toBe(false);
    expect(d.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Hi"],
      ["assistant", "The late answer"],
    ]);
    expect(d.title).toBe("A chat");
    // Resumable: the list shows it, and the next turn continues the same transcript.
    expect((await w.controller.list(WS, viewer(AGENT))).items[0]).toMatchObject({ id: sessionId, running: false });
  });

  it("status, list, get and delete are the member's own", async () => {
    const w = copilotWorld();
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(w.controller.status()).toEqual({ available: false, reasons: ["no_key"] });
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
    await withKey(async () => expect(w.controller.status()).toEqual({ available: true, reasons: [] }));
    const t = await withKey(() => w.turn(AGENT, body()));
    expect(await httpError(w.controller.get(WS, viewer(OWNER), t.sessionId))).toMatchObject({ status: 404 });
  });
});
