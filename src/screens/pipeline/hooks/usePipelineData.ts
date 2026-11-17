import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Pipeline, TicketsDashboardSummary } from "@/lib/types";

export function usePipelines() {
  return useQuery<Pipeline[]>({
    queryKey: qk.pipelines(),
    queryFn: ({ signal }) => api.get<Pipeline[]>("/pipelines", signal),
    staleTime: 60_000, // pipelines change rarely
    // The server already hides archived pipelines; keep the picker safe even
    // if a cached list predates an archive.
    select: (list) => list.filter((p) => !p.archivedAt),
  });
}

export function usePipelineSummary(pipelineId: string | null) {
  return useQuery<TicketsDashboardSummary>({
    queryKey: pipelineId ? qk.summary(pipelineId) : ["__disabled__", "pipelineSummary"],
    queryFn: ({ signal }) =>
      api.get<TicketsDashboardSummary>(
        `/tickets/dashboard/summary?pipelineId=${encodeURIComponent(pipelineId!)}`,
        signal,
      ),
    enabled: !!pipelineId,
  });
}
