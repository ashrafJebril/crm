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
  // When set, refetch every N milliseconds. Polling pauses while the document
  // is hidden (background tab) to avoid burning quota.
  pollMs?: number;
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
  // Track the last (path, key) we fetched against so we can clear stale data
  // when those change (e.g., switching conversations / workspaces) without
  // also flashing the UI on every poll tick.
  const lastSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    const sig = `${path}|${opts.key ?? ""}`;
    if (lastSigRef.current !== sig) {
      // Path or key changed — drop the previous result so consumers see a
      // clean loading state instead of stale rows from the previous query.
      setData(null);
      setError(null);
      lastSigRef.current = sig;
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

  // Polling — silently bumps the tick on an interval. Pauses when tab is hidden.
  useEffect(() => {
    if (!enabled || !opts.pollMs || opts.pollMs <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setTick((n) => n + 1);
      }
    }, opts.pollMs);
    return () => window.clearInterval(id);
  }, [enabled, opts.pollMs]);

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
