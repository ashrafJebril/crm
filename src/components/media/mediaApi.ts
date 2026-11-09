import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { API_BASE, ApiError, tokenStore } from "@/api/client";
import {
  NEXT_BEFORE_HEADER,
  flattenMediaPages,
  mediaPagePath,
  parseMediaPage,
  type MediaCategory,
  type MediaPage,
} from "./mediaKinds";

/**
 * One page of GET /media. A raw fetch, because the JSON client drops response
 * headers and the cursor lives in `X-Media-Next-Before` (absent = end).
 */
export async function fetchMediaPage(kind: MediaCategory, before: string | null, signal?: AbortSignal): Promise<MediaPage> {
  const tok = tokenStore.get();
  const res = await fetch(`${API_BASE}${mediaPagePath(kind, before)}`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    signal,
  });
  const raw = await res.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    body = raw;
  }
  if (!res.ok) {
    const m = (body as { message?: unknown } | undefined)?.message;
    throw new ApiError(typeof m === "string" ? m : `HTTP ${res.status}`, res.status, undefined, body);
  }
  return parseMediaPage(body, res.headers.get(NEXT_BEFORE_HEADER));
}

export const MEDIA_PAGES_KEY = "media-pages";

/** Paged library listing for the Gallery and the header picker; "Load more" follows the cursor header. */
export function useMediaPages(kind: MediaCategory, enabled = true) {
  const qc = useQueryClient();
  const q = useInfiniteQuery<MediaPage, Error>({
    queryKey: [MEDIA_PAGES_KEY, kind],
    queryFn: ({ pageParam, signal }) => fetchMediaPage(kind, (pageParam as string | null) ?? null, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled,
  });
  const items = flattenMediaPages(q.data?.pages ?? []);
  // Every kind's list (and the plain /media list the Media screen and composer use) may hold the file.
  const invalidate = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [MEDIA_PAGES_KEY] }),
      qc.invalidateQueries({ queryKey: ["/media"] }),
    ]);
  }, [qc]);
  return {
    items,
    loading: q.isPending && enabled,
    error: q.error,
    hasMore: !!q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
    invalidate,
  };
}
