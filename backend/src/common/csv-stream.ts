import type { Response } from "express";

/**
 * Streamed CSV downloads (SP-03 contacts export, SP-12 campaign export).
 * Moved from ContactsController.stream without behaviour change.
 */
export interface ExportSink {
  /** Awaited so the caller can apply backpressure. */
  write(chunk: string): Promise<void> | void;
  /** True once the client went away; the cursor loop stops. */
  aborted(): boolean;
}

export interface PreparedExport {
  /** ASCII only: it goes into Content-Disposition as is. */
  filename: string;
  run(sink: ExportSink): Promise<{ rows: number }>;
}

/**
 * Sends `job` as a `text/csv` attachment. Everything that can fail with a
 * normal JSON error must happen before this is called (in `prepare`); once
 * the first byte is out, an error can only cut the stream.
 */
export async function streamCsv(res: Response, job: PreparedExport): Promise<void> {
  let closed = false;
  res.on("close", () => {
    if (!res.writableEnded) closed = true;
  });
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  try {
    await job.run({
      aborted: () => closed,
      write: (chunk) => {
        if (closed) return;
        if (res.write(chunk)) return;
        return new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      },
    });
  } catch (err) {
    // Headers are already sent; the best we can do is cut the stream.
    if (!res.headersSent) throw err;
    res.destroy(err as Error);
    return;
  }
  if (!closed) res.end();
}
