import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtime } from "@/api/useRealtime";
import { qk } from "@/api/queryKeys";
import type { Ticket, TicketsListPage } from "@/lib/types";

type StageCache = { pages: TicketsListPage[]; pageParams: unknown[] };

/** Subscribe to realtime ticket events for a given pipeline. Idempotent —
 *  if the origin tab already patched its own cache via mutation, the realtime
 *  patch is a no-op since the shapes match. */
export function useTicketRealtime(pipelineId: string | null) {
  const qc = useQueryClient();

  // ticket.moved → remove from source, add to destination
  useRealtime<{ ticket: Ticket; fromStageId: string; toStageId: string }>(
    "ticket.moved",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        // Remove from source
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.fromStageId] },
          (curr) => {
            if (!curr) return curr;
            return {
              ...curr,
              pages: curr.pages.map((p) => ({
                ...p,
                items: p.items.filter((t) => t.id !== data.ticket.id),
              })),
            };
          },
        );
        // Upsert into destination (if not already present)
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.toStageId] },
          (curr) => {
            if (!curr) return curr;
            const present = curr.pages.some((p) =>
              p.items.some((t) => t.id === data.ticket.id),
            );
            if (present) {
              return {
                ...curr,
                pages: curr.pages.map((p) => ({
                  ...p,
                  items: p.items.map((t) => (t.id === data.ticket.id ? data.ticket : t)),
                })),
              };
            }
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [{ ...first, items: [data.ticket, ...first.items] }, ...rest],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
      },
      [qc, pipelineId],
    ),
  );

  // ticket.created → prepend to destination stage
  useRealtime<{ ticket: Ticket }>(
    "ticket.created",
    useCallback(
      (data) => {
        if (!pipelineId) return;
        if (data.ticket.pipelineId !== pipelineId) return;
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage", pipelineId, data.ticket.stageId] },
          (curr) => {
            if (!curr) return curr;
            const present = curr.pages.some((p) =>
              p.items.some((t) => t.id === data.ticket.id),
            );
            if (present) return curr;
            const [first, ...rest] = curr.pages;
            return {
              ...curr,
              pages: [{ ...first, items: [data.ticket, ...first.items] }, ...rest],
            };
          },
        );
        qc.invalidateQueries({ queryKey: qk.summary(pipelineId) });
      },
      [qc, pipelineId],
    ),
  );

  // ticket.updated → patch single ticket + every stage list it lives in
  useRealtime<{ ticket: Ticket }>(
    "ticket.updated",
    useCallback(
      (data) => {
        qc.setQueryData(qk.ticket(data.ticket.id), data.ticket);
        qc.setQueriesData<StageCache>(
          { queryKey: ["tickets", "stage"] },
          (curr) => {
            if (!curr) return curr;
            return {
              ...curr,
              pages: curr.pages.map((p) => ({
                ...p,
                items: p.items.map((t) => (t.id === data.ticket.id ? data.ticket : t)),
              })),
            };
          },
        );
      },
      [qc],
    ),
  );
}
