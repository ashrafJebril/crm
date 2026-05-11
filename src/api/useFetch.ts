import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./client";

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface FetchOpts {
  enabled?: boolean;
  // Bumping `key` forces re-fetch (use after a mutation invalidates cache).
  key?: string | number;
}

/** GET hook with abort + manual refetch. Re-runs when path or key changes. */
export function useFetch<T>(
  path: string | null,
  opts: FetchOpts = {},
): FetchState<T> {
  const enabled = opts.enabled !== false && path !== null;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    api
      .get<T>(path, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof ApiError ? e.message : "Request failed");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, enabled, tick, opts.key]);

  const refetch = useCallback(() => setTick((n) => n + 1), []);
  return { data, loading, error, refetch };
}

interface MutationState<TInput, TOutput> {
  mutate: (input: TInput) => Promise<TOutput>;
  loading: boolean;
  error: string | null;
}

/** Imperative mutation hook (POST/PATCH/DELETE). */
export function useMutation<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>,
): MutationState<TInput, TOutput> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const mutate = useCallback(async (input: TInput) => {
    setLoading(true);
    setError(null);
    try {
      return await fnRef.current(input);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Request failed";
      setError(msg);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { mutate, loading, error };
}
