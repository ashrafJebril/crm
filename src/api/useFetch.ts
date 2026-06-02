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
  // Holds the controller for the currently in-flight request. We only ever
  // abort this when the (path, key) signature actually changes — polling
  // ticks do not abort, so a slow Graph call doesn't get stuck in an
  // abort-and-restart loop.
  const abortRef = useRef<AbortController | null>(null);
  const lastSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || path === null) {
      setLoading(false);
      return;
    }
    const sig = `${path}|${opts.key ?? ""}`;
    const sigChanged = lastSigRef.current !== sig;
    if (sigChanged) {
      // Path or key changed — abort whatever's running and drop the previous
      // payload so the UI shows a clean loading state for the new query.
      abortRef.current?.abort();
      setData(null);
      setError(null);
      lastSigRef.current = sig;
    } else if (abortRef.current && !abortRef.current.signal.aborted) {
      // Poll tick fired while the previous fetch is still in flight. Let it
      // finish — don't restart. This is the critical difference from a naive
      // abort-on-every-tick: a Graph call that takes longer than pollMs would
      // otherwise be stuck cancelling itself forever.
      return;
    }
    const ctrl = new AbortController();
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
        // Only clear loading if this is still the active controller. Aborts
        // from sig changes will already have started a fresh in-flight
        // request — don't toggle that one off.
        if (ctrl === abortRef.current) setLoading(false);
      });
    // No effect-cleanup abort here: we want polling tick re-runs to leave the
    // in-flight request alone. Aborts happen via sigChanged + the unmount
    // effect below.
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
