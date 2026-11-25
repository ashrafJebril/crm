import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Ticket } from "@/lib/types";

export interface TableTicketsPage {
  items: Ticket[];
  nextCursor: string | null;
  total: number;
}

/** Table view: GET /tickets?view=table (cursor paged, 50 rows). `qs` already carries filters + sort. */
export function useTableTickets(pipelineId: string | null, qs: string) {
  return useInfiniteQuery<TableTicketsPage>({
    queryKey: ["tickets", "table", pipelineId, qs],
    enabled: !!pipelineId,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(qs);
      params.set("pipelineId", pipelineId!);
      if (pageParam) params.set("cursor", pageParam as string);
      return api.get<TableTicketsPage>(`/tickets?${params.toString()}`, signal);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 10_000,
  });
}

export interface BulkResult {
  affected: number;
  skipped: string[];
}
export type BulkVars =
  | { ids: string[]; op: "assign"; ownerId: string | null }
  | { ids: string[]; op: "lost"; lostReasonId: string }
  | { ids: string[]; op: "notALead" };

/** Lead won / lost / not-a-lead / reopen change the contact (lifecycle, notALead flag). */
export function invalidateContactCaches(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["contacts"] });
  void qc.invalidateQueries({ queryKey: ["record", "contact"] });
}

function useInvalidateBoard() {
  const qc = useQueryClient();
  return (pipelineId?: string) => {
    invalidateContactCaches(qc);
    void qc.invalidateQueries({ queryKey: ["tickets"] });
    if (pipelineId) void qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
  };
}

export function useBulkTickets(pipelineId: string) {
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: (v: BulkVars) => api.post<BulkResult>("/tickets/bulk", v),
    onSettled: () => invalidate(pipelineId),
  });
}

export function useReopenTicket() {
  const qc = useQueryClient();
  const invalidate = useInvalidateBoard();
  return useMutation({
    mutationFn: (ticketId: string) => api.post<Ticket>(`/tickets/${ticketId}/reopen`, {}),
    onSettled: (_d, _e, ticketId) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
    },
  });
}

export interface ContactHit {
  id: string;
  name: string;
  phone?: string;
}

/** Customer typeahead over GET /contacts/page?q=. */
export function useContactSearch(q: string) {
  const term = q.trim();
  return useQuery<ContactHit[]>({
    queryKey: ["contacts", "typeahead", term],
    enabled: term.length >= 2,
    queryFn: async ({ signal }) => {
      const r = await api.get<{ items: ContactHit[] }>(
        `/contacts/page?q=${encodeURIComponent(term)}&page=1&pageSize=8`,
        signal,
      );
      return r.items;
    },
    staleTime: 30_000,
  });
}
