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
  const inFlightRef = useRef<boolean>(false);
  const lastSigRef = useRef<string | null>(null);
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    const sig = `${path}|${opts.key ?? ""}`;
    const sigChanged = lastSigRef.current !== sig;
    const pathChanged = lastPathRef.current !== path;
    if (sigChanged) {
      // Path or key changed — abort the in-flight call and start fresh.
      abortRef.current?.abort();
      inFlightRef.current = false;
      // Only wipe cached data when the path itself changes. A pure key bump
      // (mutation-driven invalidation) keeps the stale value visible so the UI
      // doesn't flash blank while the refetch resolves.
      if (pathChanged) setData(null);
      setError(null);
      lastSigRef.current = sig;
      lastPathRef.current = path;
    } else if (inFlightRef.current) {
      // Poll tick while a previous fetch is still resolving. Let it finish —
      // a slow Graph call must not get stuck in an abort/restart loop.
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    inFlightRef.current = true;
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
        // Always free the in-flight slot so the next poll tick can proceed.
        // Only clear loading if this is still the active controller — a
        // request that was aborted because the user switched threads
        // shouldn't toggle the new request's loading off.
        if (ctrl === abortRef.current) {
          inFlightRef.current = false;
          setLoading(false);
        }
      });
  }, [path, enabled, tick, opts.key]);

  // Final abort on unmount, so an in-flight call doesn't try to setState on a
  // dead component.
  useEffect(() => () => {
    abortRef.current?.abort();
  }, []);

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
