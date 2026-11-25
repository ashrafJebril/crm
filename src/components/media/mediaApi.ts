import { useInfiniteQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/api/client";
import type { Media } from "@/lib/types";
import type { UpdateMediaBody } from "./mediaDetails";
import {
  NEXT_BEFORE_HEADER,
  flattenMediaPages,
  mediaPagePath,
  parseMediaPage,
  type MediaCategory,
  type MediaFilters,
  type MediaPage,
} from "./mediaKinds";

/**
 * One page of GET /media. The cursor lives in the `X-Media-Next-Before`
 * header (absent = end), so this uses the client's header-returning GET,
 * which keeps its session rules: a rejected token logs out (SP-13 final review).
 */
export async function fetchMediaPage(
  kind: MediaCategory,
  before: string | null,
  signal?: AbortSignal,
  filters: MediaFilters = {},
): Promise<MediaPage> {
  const { data, headers } = await api.getWithHeaders<unknown>(mediaPagePath(kind, before, undefined, filters), signal);
  return parseMediaPage(data, headers.get(NEXT_BEFORE_HEADER));
}

export const MEDIA_PAGES_KEY = "media-pages";

/** Every paged list (any kind or filter) and the plain /media list may hold a file. */
export async function invalidateMediaLists(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: [MEDIA_PAGES_KEY] }),
    qc.invalidateQueries({ queryKey: ["/media"] }),
  ]);
}

/** SP-17 PATCH /media/:id: details and the agent switch. Returns the updated row. */
export const updateMedia = (id: string, body: UpdateMediaBody): Promise<Media> =>
  api.patch<Media>(`/media/${encodeURIComponent(id)}`, body);

/** The filters as they go into the query key (normalised, so equal filters share a cache entry). */
export function mediaFilterKey(filters: MediaFilters = {}): { q: string; approved: boolean | null } {
  return { q: (filters.q ?? "").trim(), approved: filters.approved ?? null };
}

/**
 * Paged library listing for the Gallery, the header picker and the agent's
 * Photos tab; "Load more" follows the cursor header. SP-17: `filters` (search
 * and approval) are part of the query key.
 */
export function useMediaPages(kind: MediaCategory, enabled = true, filters: MediaFilters = {}) {
  const qc = useQueryClient();
  const fk = mediaFilterKey(filters);
  const q = useInfiniteQuery<MediaPage, Error>({
    queryKey: [MEDIA_PAGES_KEY, kind, fk],
    queryFn: ({ pageParam, signal }) =>
      fetchMediaPage(kind, (pageParam as string | null) ?? null, signal, {
        q: fk.q || undefined,
        approved: fk.approved ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled,
  });
  const items = flattenMediaPages(q.data?.pages ?? []);
  // Every kind's list (and the plain /media list the Media screen and composer use) may hold the file.
  const invalidate = useCallback(() => invalidateMediaLists(qc), [qc]);
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
