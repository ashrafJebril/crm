import { useCallback, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { api, ApiError } from "./client";

type DataUpdater<T> = T | null | ((prev: T | null) => T | null);

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Patch the cached value without a network round-trip. Use for optimistic
   *  mutations — e.g. move a card to a new column instantly, then reconcile
   *  with the server response in the background. */
  setData: (updater: DataUpdater<T>) => void;
}

interface FetchOpts {
  enabled?: boolean;
  // Bumping `key` forces re-fetch (use after a mutation invalidates cache).
  key?: string | number;
  // When set, refetch every N milliseconds. Polling pauses while the document
  // is hidden (background tab) to avoid burning quota — handled natively by
  // React Query's refetchIntervalInBackground:false.
  pollMs?: number;
}

/** GET hook backed by React Query. Two components asking for the same URL
 *  share one in-flight request and one cache entry — no more duplicate GETs.
 *  Path = null disables the query. */
export function useFetch<T>(
  path: string | null,
  opts: FetchOpts = {},
): FetchState<T> {
  const enabled = opts.enabled !== false && path !== null;
  const queryClient = useQueryClient();

  // Disabled hooks share a sentinel key. When the caller passes opts.key the
  // queryKey includes it (so a bump creates a fresh entry — legacy
  // invalidation pattern). When opts.key is omitted the key is just [path],
  // letting mutations patch the cache without guessing a suffix.
  const queryKey: QueryKey = !enabled
    ? ["__disabled__"]
    : opts.key !== undefined
      ? [path, opts.key]
      : [path];
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  const q = useQuery<T, Error>({
    queryKey,
    queryFn: async ({ signal }) => {
      if (path === null) throw new Error("no path");
      return api.get<T>(path, signal);
    },
    enabled,
    refetchInterval:
      opts.pollMs && opts.pollMs > 0 ? opts.pollMs : false,
    refetchIntervalInBackground: false,
    // When a consumer bumps `opts.key` to invalidate, React Query treats the
    // new queryKey as a brand-new cache entry with no data. keepPreviousData
    // shows the last successful result while the new key fetches, so the UI
    // never flashes blank during a mutation-driven refetch.
    placeholderData: keepPreviousData,
  });

  const refetch = useCallback(() => {
    void q.refetch();
  }, [q]);

  const setData = useCallback(
    (updater: DataUpdater<T>) => {
      queryClient.setQueryData<T | null>(queryKeyRef.current, (prev) => {
        const p = (prev ?? null) as T | null;
        return typeof updater === "function"
          ? (updater as (p: T | null) => T | null)(p)
          : updater;
      });
    },
    [queryClient],
  );

  const errorMsg = q.error
    ? q.error instanceof ApiError
      ? q.error.message
      : q.error.message || "Request failed"
    : null;

  return {
    data: (q.data ?? null) as T | null,
    // isFetching covers both first-load and background refetches, matching
    // the old hook's "loading == any request is active" semantics.
    loading: enabled && q.isFetching,
    error: errorMsg,
    refetch,
    setData,
  };
}

interface MutationState<TInput, TOutput> {
  mutate: (input: TInput) => Promise<TOutput>;
  loading: boolean;
  error: string | null;
}

/** Imperative mutation hook (POST/PATCH/DELETE). Kept as a thin wrapper —
 *  optimistic patterns are handled per call-site via useFetch's setData. */
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
