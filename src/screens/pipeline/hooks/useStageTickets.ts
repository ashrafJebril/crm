import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { TicketsListPage } from "@/lib/types";

interface StageTicketsFilters {
  /** Server filter query string from boardQuery.toQuery (no view/sort). */
  qs?: string;
}

export function useStageTickets(
  pipelineId: string | null,
  stageId: string | null,
  filters: StageTicketsFilters = {},
) {
  const enabled = !!pipelineId && !!stageId;

  return useInfiniteQuery<TicketsListPage>({
    queryKey: enabled
      ? qk.stageTickets(pipelineId!, stageId!, filters)
      : ["__disabled__", "stageTickets"],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set("pipelineId", pipelineId!);
      params.set("stageId", stageId!);
      params.set("limit", "50");
      if (filters.qs) new URLSearchParams(filters.qs).forEach((v, k) => params.set(k, v));
      if (pageParam) params.set("cursor", pageParam as string);
      return api.get<TicketsListPage>(`/tickets?${params.toString()}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 10_000,
  });
}
