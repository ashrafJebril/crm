import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { TicketsListPage } from "@/lib/types";

interface StageTicketsFilters {
  ownerId?: string;
  q?: string; // client-side search, kept in the key so cache stays stable
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
      : ["__disabled__"],
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      params.set("pipelineId", pipelineId!);
      params.set("stageId", stageId!);
      params.set("limit", "50");
      if (filters.ownerId) params.set("ownerId", filters.ownerId);
      if (pageParam) params.set("cursor", pageParam as string);
      return api.get<TicketsListPage>(`/tickets?${params.toString()}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 10_000,
  });
}
