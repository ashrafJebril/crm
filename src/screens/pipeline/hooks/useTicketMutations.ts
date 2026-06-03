import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type {
  Ticket,
  TicketActivity,
  TicketsListPage,
} from "@/lib/types";

type StageTicketsCache = { pages: TicketsListPage[]; pageParams: unknown[] };

/** Walk every stageTickets cache page and apply a per-page transform. */
function patchStageCache(
  qc: ReturnType<typeof useQueryClient>,
  pipelineId: string,
  stageId: string,
  fn: (items: Ticket[]) => Ticket[],
) {
  qc.setQueriesData<StageTicketsCache>(
    { queryKey: ["tickets", "stage", pipelineId, stageId] },
    (curr) => {
      if (!curr) return curr;
      return {
        ...curr,
        pages: curr.pages.map((p) => ({ ...p, items: fn(p.items) })),
      };
    },
  );
}

/** Strip a ticket from every stage cache in the given pipeline (used before
 *  inserting it into its new stage, so duplicates are mathematically
 *  impossible regardless of which stage previously held it). */
function removeFromAllStages(
  qc: ReturnType<typeof useQueryClient>,
  pipelineId: string,
  ticketId: string,
) {
  qc.setQueriesData<StageTicketsCache>(
    { queryKey: ["tickets", "stage", pipelineId] },
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

// ─── Move ───────────────────────────────────────────────────────────────

interface MoveVars {
  ticketId: string;
  fromStageId: string;
  toStageId: string;
  pipelineId: string;
  lostReason?: string;
  optimisticTicket: Ticket; // current ticket snapshot for the optimistic prepend
}

export function useMoveTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: MoveVars) =>
      api.post<Ticket>(`/tickets/${v.ticketId}/move`, {
        stageId: v.toStageId,
        lostReason: v.lostReason,
      }),
    onMutate: async (v) => {
      // Snapshot every stage cache in this pipeline so rollback is complete
      // regardless of where the ticket was actually held.
      const pipelineKey = ["tickets", "stage", v.pipelineId];
      await qc.cancelQueries({ queryKey: pipelineKey });
      const snap = qc.getQueriesData<StageTicketsCache>({
        queryKey: pipelineKey,
      });

      // Strip the ticket from every stage cache in this pipeline …
      removeFromAllStages(qc, v.pipelineId, v.ticketId);
      // … then prepend it to the destination stage. Single source of truth.
      patchStageCache(qc, v.pipelineId, v.toStageId, (items) => [
        { ...v.optimisticTicket, stageId: v.toStageId },
        ...items,
      ]);

      return { snap };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snap.forEach(([key, val]) => qc.setQueryData(key, val));
    },
    onSettled: (_data, _err, v) => {
      qc.invalidateQueries({
        queryKey: ["tickets", "stage", v.pipelineId],
      });
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
    },
  });
}

// ─── Create ─────────────────────────────────────────────────────────────

interface CreateVars {
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  description?: string;
  value?: number;
  ownerId?: string;
  conversationId?: string;
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: CreateVars) => api.post<Ticket>("/tickets", v),
    onSuccess: (ticket, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) => [ticket, ...items]);
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
      if (v.conversationId) {
        qc.invalidateQueries({ queryKey: qk.conversationTickets(v.conversationId) });
      }
    },
  });
}

/** Create from a conversation (Inbox flow). Server resolves contactId. */
export function useCreateTicketFromConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      conversationId: string;
      pipelineId: string;
      stageId: string;
      title: string;
      description?: string;
      value?: number;
      ownerId?: string;
    }) =>
      api.post<Ticket>(`/tickets/from-conversation/${v.conversationId}`, {
        pipelineId: v.pipelineId,
        stageId: v.stageId,
        title: v.title,
        description: v.description,
        value: v.value,
        ownerId: v.ownerId,
      }),
    onSuccess: (ticket, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) => [ticket, ...items]);
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
      qc.invalidateQueries({ queryKey: qk.conversationTickets(v.conversationId) });
    },
  });
}

// ─── Update ─────────────────────────────────────────────────────────────

export function useUpdateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      patch: { title?: string; description?: string; value?: number; ownerId?: string };
    }) => api.patch<Ticket>(`/tickets/${v.id}`, v.patch),
    onSuccess: (ticket) => {
      qc.setQueryData(qk.ticket(ticket.id), ticket);
      // Patch every stage cache that might contain it (pipelineId may vary)
      qc.setQueriesData<StageTicketsCache>(
        { queryKey: ["tickets", "stage"] },
        (curr) => {
          if (!curr) return curr;
          return {
            ...curr,
            pages: curr.pages.map((p) => ({
              ...p,
              items: p.items.map((t) => (t.id === ticket.id ? ticket : t)),
            })),
          };
        },
      );
      qc.invalidateQueries({ queryKey: qk.summary(ticket.pipelineId) });
    },
  });
}

// ─── Add note ───────────────────────────────────────────────────────────

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { ticketId: string; note: string }) =>
      api.post<TicketActivity>(`/tickets/${v.ticketId}/notes`, { note: v.note }),
    onSuccess: (_a, v) => {
      qc.invalidateQueries({ queryKey: qk.ticket(v.ticketId) });
    },
  });
}

// ─── Delete ─────────────────────────────────────────────────────────────

export function useDeleteTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { id: string; pipelineId: string; stageId: string }) =>
      api.delete(`/tickets/${v.id}`),
    onSuccess: (_a, v) => {
      patchStageCache(qc, v.pipelineId, v.stageId, (items) =>
        items.filter((t) => t.id !== v.id),
      );
      qc.invalidateQueries({ queryKey: qk.summary(v.pipelineId) });
    },
  });
}
