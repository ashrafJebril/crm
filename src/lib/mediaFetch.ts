// Authenticated media downloads for thumbnail grids.
//
// <img> can't send the bearer token, so tiles fetch each file and render a
// blob URL. A grid used to fire every request at once; each one costs the
// backend a database lookup before it streams from Spaces, so a slow or
// just-woken database failed a whole batch, and tiles stayed blank with no
// retry. This queue caps concurrency and retries transient failures.

export class MediaFetchError extends Error {
  /** HTTP status, or 0 for a network failure. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "MediaFetchError";
    this.status = status;
  }
}

interface Options {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Max requests in flight. */
  concurrency?: number;
  /** Extra attempts after the first for 5xx / 429 / network errors. */
  retries?: number;
}

const abortError = () => new DOMException("Aborted", "AbortError");
const isTransient = (status: number) => status === 0 || status === 429 || status >= 500;

export function createMediaFetcher({
  fetchFn = (...args) => fetch(...args),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  concurrency = 6,
  retries = 3,
}: Options = {}) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function slot(signal?: AbortSignal) {
    if (active < concurrency) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    // The freed slot was handed to us; give it back if we no longer need it.
    if (signal?.aborted) {
      release();
      throw abortError();
    }
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  async function attempt(url: string, token: string | null, signal?: AbortSignal): Promise<Blob> {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal });
    } catch (e) {
      if (signal?.aborted) throw abortError();
      throw new MediaFetchError((e as Error).message || "Network error", 0);
    }
    if (!res.ok) throw new MediaFetchError(`HTTP ${res.status}`, res.status);
    return res.blob();
  }

  return async function load(url: string, token: string | null, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) throw abortError();
    await slot(signal);
    try {
      for (let i = 0; ; i++) {
        try {
          return await attempt(url, token, signal);
        } catch (e) {
          const retryable = e instanceof MediaFetchError && isTransient(e.status);
          if (!retryable || i >= retries || signal?.aborted) throw e;
          await sleep(500 * 2 ** i); // 0.5s, 1s, 2s
        }
      }
    } finally {
      release();
    }
  };
}

/** Shared queue for every media thumbnail in the app. */
export const loadMedia = createMediaFetcher();
