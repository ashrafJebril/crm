import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtime } from "@/api/useRealtime";
import { qk } from "@/api/queryKeys";
import type { Ticket, TicketsListPage } from "@/lib/types";
import { isRefetchOnRealtimeKey, isUnfilteredStageKey } from "./realtimeKeys";

const REFETCH_DEBOUNCE_MS = 500;

type StageCache = { pages: TicketsListPage[]; pageParams: unknown[] };

/** Remove a ticket from every stage cache under the given pipeline. */
function stripFromAllStages(
  qc: ReturnType<typeof useQueryClient>,
  pipelineId: string,
  ticketId: string,
) {
  qc.setQueriesData<StageCache>(
    { queryKey: ["tickets", "stage", pipelineId], predicate: (q) => isUnfilteredStageKey(q.queryKey, pipelineId) },
    (curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        pages: curr.pages.map((p) => ({
          ...p,
          items: p.items.filter((t) => t.id !== ticketId),
        })),
      };
    },
  );
}

/** Subscribe to realtime ticket events for a given pipeline. Each handler
 *  enforces the invariant: a ticket exists in AT MOST one stage cache. */
export function useTicketRealtime(pipelineId: string | null) {
  const qc = useQueryClient();

  // Filtered stage caches and the table can't be patched blindly: refetch, debounced.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const scheduleRefetch = useCallback(() => {
    if (!pipelineId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      qc.invalidateQueries({ predicate: (q) => isRefetchOnRealtimeKey(q.queryKey, pipelineId) });
    }, REFETCH_DEBOUNCE_MS);
  }, [qc, pipelineId]);

  // ticket.moved → strip everywhere, place into target stage
  useRealtime<{ ticket: Ticket; fromStageId: string; toStageId: string }>(
    "ticket.moved",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        stripFromAllStages(qc, pipelineId, data.ticket.id);
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.toStageId], predicate: (q) => isUnfilteredStageKey(q.queryKey, pipelineId) },
          (curr) => {
            if (!curr) return curr;
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [
                { ...first, items: [data.ticket, ...first.items] },
                ...rest,
              ],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
        scheduleRefetch();
      },
      [qc, pipelineId, scheduleRefetch],
    ),
  );

  // ticket.created → ensure single instance in the target stage
  useRealtime<{ ticket: Ticket }>(
    "ticket.created",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        stripFromAllStages(qc, pipelineId, data.ticket.id);
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.ticket.stageId], predicate: (q) => isUnfilteredStageKey(q.queryKey, pipelineId) },
          (curr) => {
            if (!curr) return curr;
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [
                { ...first, items: [data.ticket, ...first.items] },
                ...rest,
              ],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
        scheduleRefetch();
      },
      [qc, pipelineId, scheduleRefetch],
    ),
  );

  // ticket.updated → patch detail cache, then enforce single-stage placement
  // based on the (possibly new) stageId. Defensive against any earlier state
  // that may have left the ticket in multiple stage caches.
  useRealtime<{ ticket: Ticket }>(
    "ticket.updated",
    useCallback(
      (data) => {
        qc.setQueryData(qk.ticket(data.ticket.id), data.ticket);
        if (!pipelineId || data.ticket.pipelineId !== pipelineId) {
          // Different pipeline — just update in place without rearranging.
          qc.setQueriesData<StageCache>(
            { queryKey: ["tickets", "stage"] },
            (curr) => {
              if (!curr) return curr;
              return {
                ...curr,
                pages: curr.pages.map((p) => ({
                  ...p,
                  items: p.items.map((t) =>
                    t.id === data.ticket.id ? data.ticket : t,
                  ),
                })),
              };
            },
          );
          return;
        }
        stripFromAllStages(qc, pipelineId, data.ticket.id);
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.ticket.stageId], predicate: (q) => isUnfilteredStageKey(q.queryKey, pipelineId) },
          (curr) => {
            if (!curr) return curr;
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [
                { ...first, items: [data.ticket, ...first.items] },
                ...rest,
              ],
            };
          },
        );
        scheduleRefetch();
      },
      [qc, pipelineId, scheduleRefetch],
    ),
  );
}
