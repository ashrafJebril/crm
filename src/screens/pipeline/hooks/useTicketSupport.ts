import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type {
  AppointmentStatus,
  Ticket,
  TicketAttachment,
  TicketAttachmentCandidate,
  TicketBookingCard,
  TicketDetail,
} from "@/lib/types";
import { withAttachment, withoutAttachment } from "../ticketAttachmentModel";
import { mergeCachedTicket } from "../ticketMerge";
import { ApiError } from "@/api/client";

/** SP-09 ticket support data: attachments, candidates, resolve and booking cards. */

export const ticketSupportKeys = {
  attachments: (ticketId: string) => ["ticketSupport", ticketId, "attachments"] as const,
  candidates: (ticketId: string) => ["ticketSupport", ticketId, "attachment-candidates"] as const,
  bookings: (ticketId: string) => ["ticketSupport", ticketId, "bookings"] as const,
};

type Items<T> = { items: T[] };

export function useTicketAttachments(ticketId: string) {
  return useQuery<TicketAttachment[]>({
    queryKey: ticketSupportKeys.attachments(ticketId),
    queryFn: async ({ signal }) => (await api.get<Items<TicketAttachment>>(`/tickets/${ticketId}/attachments`, signal)).items,
  });
}

/** Customer files from the ticket's conversation (tickets.update); fetched only while the picker is open. */
export function useAttachmentCandidates(ticketId: string, enabled: boolean) {
  return useQuery<TicketAttachmentCandidate[]>({
    queryKey: ticketSupportKeys.candidates(ticketId),
    enabled,
    queryFn: async ({ signal }) =>
      (await api.get<Items<TicketAttachmentCandidate>>(`/tickets/${ticketId}/attachments/candidates`, signal)).items,
    staleTime: 10_000,
  });
}

/** After the file list changes: the detail and board counts move too. */
function useAfterAttachmentChange() {
  const qc = useQueryClient();
  return (ticketId: string, delta: number, list?: (prev: TicketAttachment[]) => TicketAttachment[]) => {
    if (list) qc.setQueryData<TicketAttachment[]>(ticketSupportKeys.attachments(ticketId), (prev) => list(prev ?? []));
    qc.setQueryData<TicketDetail>(qk.ticket(ticketId), (prev) =>
      prev ? { ...prev, attachmentCount: Math.max(0, (prev.attachmentCount ?? 0) + delta) } : prev,
    );
    void qc.invalidateQueries({ queryKey: ticketSupportKeys.attachments(ticketId) });
    void qc.invalidateQueries({ queryKey: ticketSupportKeys.candidates(ticketId) });
    // Cards and table rows show the count.
    void qc.invalidateQueries({ queryKey: ["tickets", "stage"] });
    void qc.invalidateQueries({ queryKey: ["tickets", "table"] });
  };
}

export function useAttachCustomerFile(ticketId: string) {
  const after = useAfterAttachmentChange();
  return useMutation({
    mutationFn: (mediaId: string) => api.post<TicketAttachment>(`/tickets/${ticketId}/attachments`, { mediaId }),
    onSuccess: (item) => after(ticketId, 1, (prev) => withAttachment(prev, item)),
  });
}

export function useUploadTicketFile(ticketId: string) {
  const after = useAfterAttachmentChange();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.postForm<TicketAttachment>(`/tickets/${ticketId}/attachments/upload`, form);
    },
    onSuccess: (item) => after(ticketId, 1, (prev) => withAttachment(prev, item)),
  });
}

export function useUnlinkAttachment(ticketId: string) {
  const after = useAfterAttachmentChange();
  return useMutation({
    mutationFn: (attId: string) => api.delete<{ ok: true }>(`/tickets/${ticketId}/attachments/${attId}`),
    onSuccess: (_r, attId) => after(ticketId, -1, (prev) => withoutAttachment(prev, attId)),
  });
}

/** POST /tickets/:id/resolve: a normal move to the pipeline's resolved stage with the note. */
export function useResolveTicket(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: string) => api.post<TicketDetail>(`/tickets/${ticketId}/resolve`, note.trim() ? { note: note.trim() } : {}),
    onSuccess: (t) => {
      qc.setQueryData<TicketDetail>(qk.ticket(ticketId), (prev) => mergeCachedTicket(prev, t));
      void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
      void qc.invalidateQueries({ queryKey: ["record", "ticket", ticketId] });
      void qc.invalidateQueries({ queryKey: ["tickets", "stage", (t as Ticket).pipelineId] });
      void qc.invalidateQueries({ queryKey: ["tickets", "table"] });
      void qc.invalidateQueries({ queryKey: qk.summary((t as Ticket).pipelineId) });
    },
    // Final review M3: any 409 (already closed, moved meanwhile, no resolved
    // stage) means our copy is stale: refetch the detail and the board.
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
        void qc.invalidateQueries({ queryKey: ["record", "ticket", ticketId] });
        void qc.invalidateQueries({ queryKey: ["tickets", "stage"] });
        void qc.invalidateQueries({ queryKey: ["tickets", "table"] });
      }
    },
  });
}

export function useTicketBookings(ticketId: string, enabled: boolean) {
  return useQuery<TicketBookingCard[]>({
    queryKey: ticketSupportKeys.bookings(ticketId),
    enabled,
    queryFn: async ({ signal }) => (await api.get<Items<TicketBookingCard>>(`/tickets/${ticketId}/bookings`, signal)).items,
  });
}

/** Confirm / Cancel through the existing PATCH /appointments/:id. */
export function useSetBookingStatus(ticketId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: Extract<AppointmentStatus, "confirmed" | "cancelled"> }) =>
      api.patch(`/appointments/${v.id}`, { status: v.status }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ticketSupportKeys.bookings(ticketId) });
      void qc.invalidateQueries({ queryKey: ["appointments"] });
    },
  });
}
