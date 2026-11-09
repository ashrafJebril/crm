import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "@/api/client";
import {
  NEXT_BEFORE_HEADER,
  flattenMediaPages,
  mediaPagePath,
  parseMediaPage,
  type MediaCategory,
  type MediaPage,
} from "./mediaKinds";

/**
 * One page of GET /media. The cursor lives in the `X-Media-Next-Before`
 * header (absent = end), so this uses the client's header-returning GET,
 * which keeps its session rules: a rejected token logs out (SP-13 final review).
 */
export async function fetchMediaPage(kind: MediaCategory, before: string | null, signal?: AbortSignal): Promise<MediaPage> {
  const { data, headers } = await api.getWithHeaders<unknown>(mediaPagePath(kind, before), signal);
  return parseMediaPage(data, headers.get(NEXT_BEFORE_HEADER));
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
