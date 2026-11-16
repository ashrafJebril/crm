/**
 * An AbortSignal that fires when the client goes away before the response
 * was sent (the response closes without finishing). Queued report sections
 * watch it and never start for a request nobody is waiting for.
 */
export function requestAbortSignal(res: {
  on(event: "close", cb: () => void): unknown;
  readonly writableFinished?: boolean;
}): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}
