import { formatBookingTexts } from "./lifecycle-text";

/**
 * SP-24 trigger payloads. Every lifecycle trigger carries pre-formatted texts
 * (templates never format dates) and an `occurrenceKey` the dispatch claims
 * once per (workflow, entity, occurrence):
 *  - `confirmed:<startAt ISO>`, `cancelled:<startAt ISO>`,
 *    `reminder:<startAt ISO>:<offsetMinutes>`;
 *  - `ticket_created:<ticketId>`, `ticket_resolved:<ticketId>:<enteredStageAt ISO>`.
 */

export function firstNameOf(contact: { firstName?: string | null; name?: string | null } | null | undefined): string {
  const first = (contact?.firstName ?? "").trim();
  if (first) return first;
  return (contact?.name ?? "").trim().split(/\s+/)[0] ?? "";
}

export interface ApptLike {
  id: string;
  contactId: string;
  service: string;
  serviceAr: string;
  startAt: Date;
  durationMin: number;
  status: string;
}

export function appointmentPayload(
  appt: ApptLike,
  contact: { id: string; name?: string | null; firstName?: string | null; phone?: string | null } | null,
  tz: string | null | undefined,
  occurrenceKey: string,
): Record<string, unknown> {
  return {
    appointment: {
      id: appt.id,
      contactId: appt.contactId,
      service: appt.service,
      serviceAr: appt.serviceAr,
      startAt: appt.startAt.toISOString(),
      durationMin: appt.durationMin,
      status: appt.status,
      ...formatBookingTexts(appt.startAt, tz),
    },
    contact: contact
      ? { id: contact.id, name: contact.name ?? "", firstName: firstNameOf(contact), phone: contact.phone ?? null }
      : { id: appt.contactId, name: "", firstName: "", phone: null },
    occurrenceKey,
  };
}

export const confirmedKey = (startAt: Date) => `confirmed:${startAt.toISOString()}`;
export const cancelledKey = (startAt: Date) => `cancelled:${startAt.toISOString()}`;
export const reminderKey = (startAt: Date, offsetMinutes: number) => `reminder:${startAt.toISOString()}:${offsetMinutes}`;
export const ticketCreatedKey = (ticketId: string) => `ticket_created:${ticketId}`;
export const ticketResolvedKey = (ticketId: string, enteredStageAt: Date) => `ticket_resolved:${ticketId}:${enteredStageAt.toISOString()}`;

/** The extra fields every ticket trigger payload carries. */
export function ticketPayloadExtras(
  ticket: { contact?: { id?: string; name?: string | null; firstName?: string | null } | null; contactId?: string },
  pipelineKind: string | null | undefined,
): Record<string, unknown> {
  const c = ticket.contact ?? null;
  return {
    pipelineKind: pipelineKind ?? null,
    contact: { id: c?.id ?? ticket.contactId ?? null, name: c?.name ?? "", firstName: firstNameOf(c) },
  };
}
