import { EventEmitter } from "events";
import { streamCsv } from "./csv-stream";

class FakeRes extends EventEmitter {
  headers: Record<string, string> = {};
  chunks: string[] = [];
  statusCode = 0;
  headersSent = false;
  writableEnded = false;
  ended = false;
  destroyed: Error | null = null;
  /** Return false (backpressure) for the next write. */
  full = false;
  status(c: number) { this.statusCode = c; return this; }
  setHeader(k: string, v: string) { this.headers[k] = v; }
  write(c: string) {
    this.headersSent = true;
    this.chunks.push(c);
    return !this.full;
  }
  end() { this.ended = true; this.writableEnded = true; this.emit("close"); }
  destroy(e: Error) { this.destroyed = e; }
}

describe("streamCsv", () => {
  it("sets the CSV attachment headers, writes the job's chunks and ends", async () => {
    const res = new FakeRes();
    await streamCsv(res as never, {
      filename: "x-2026-01-01.csv",
      run: async (sink) => {
        await sink.write("a\r\n");
        await sink.write("b\r\n");
        return { rows: 1 };
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="x-2026-01-01.csv"');
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.chunks).toEqual(["a\r\n", "b\r\n"]);
    expect(res.ended).toBe(true);
  });

  it("waits for drain under backpressure, and reports a client abort", async () => {
    const res = new FakeRes();
    let abortedSeen = false;
    await streamCsv(res as never, {
      filename: "f.csv",
      run: async (sink) => {
        res.full = true;
        const w = sink.write("1");
        expect(w).toBeInstanceOf(Promise);
        res.full = false;
        res.emit("close"); // the client goes away while we wait
        await w;
        abortedSeen = sink.aborted();
        await sink.write("2"); // ignored once closed
        return { rows: 0 };
      },
    });
    expect(abortedSeen).toBe(true);
    expect(res.chunks).toEqual(["1"]);
    expect(res.ended).toBe(false);
  });

  it("throws a pre-header error as a normal response, and cuts the stream after headers", async () => {
    const before = new FakeRes();
    const boom = new Error("boom");
    // run throws before writing: headers are not sent yet, so the error propagates.
    await expect(
      streamCsv(before as never, { filename: "f.csv", run: async () => { throw boom; } }),
    ).rejects.toBe(boom);

    const after = new FakeRes();
    await streamCsv(after as never, {
      filename: "f.csv",
      run: async (sink) => {
        await sink.write("x");
        throw boom;
      },
    });
    expect(after.destroyed).toBe(boom);
    expect(after.ended).toBe(false);
  });
});
