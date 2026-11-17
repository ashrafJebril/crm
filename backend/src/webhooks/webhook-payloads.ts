import type { PrismaService } from "../prisma/prisma.service";
import type { WebhookEmit, WebhookEventType } from "./webhook-events";

/**
 * SP-27: the `data` of each webhook event, built by RE-READING the record by
 * (id, workspaceId) through a whitelisting select, never from the raw
 * workflow payload. Only the fields documented on the developers page leave
 * the CRM: no custom fields, notes, internal ids beyond the documented
 * references, owners' emails or integration identities.
 */
type Db = Pick<PrismaService, "contact" | "message" | "ticket" | "appointment" | "conversation" | "user">;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function tagsOf(raw: unknown): string[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export const CONTACT_FIELDS = ["id", "name", "firstName", "lastName", "email", "phone", "lifecycle", "source", "tags", "createdAt"] as const;

async function contact(db: Db, workspaceId: string, id: string) {
  const c = await db.contact.findFirst({
    where: { id, workspaceId },
    select: { id: true, name: true, firstName: true, lastName: true, email: true, phone: true, lifecycle: true, source: true, tags: true, createdAt: true },
  });
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    lifecycle: c.lifecycle,
    source: c.source,
    tags: tagsOf(c.tags),
    createdAt: iso(c.createdAt),
  };
}

async function contactRef(db: Db, workspaceId: string, id: string | null | undefined) {
  if (!id) return null;
  const c = await db.contact.findFirst({ where: { id, workspaceId }, select: { id: true, name: true, phone: true } });
  return c ? { id: c.id, name: c.name, phone: c.phone ?? null } : null;
}

async function ticket(db: Db, workspaceId: string, id: string) {
  const t = await db.ticket.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      number: true,
      title: true,
      pipelineId: true,
      stageId: true,
      contactId: true,
      conversationId: true,
      ownerId: true,
      priority: true,
      value: true,
      currency: true,
      createdAt: true,
      enteredStageAt: true,
      closedAt: true,
      stage: { select: { id: true, key: true, label: true, labelAr: true, isTerminal: true, isWon: true } },
    },
  });
  if (!t) return null;
  return {
    ticket: {
      id: t.id,
      number: t.number,
      title: t.title,
      pipelineId: t.pipelineId,
      stage: t.stage
        ? { id: t.stage.id, key: t.stage.key, label: t.stage.label, labelAr: t.stage.labelAr, isTerminal: t.stage.isTerminal, isWon: t.stage.isWon }
        : { id: t.stageId },
      contactId: t.contactId,
      conversationId: t.conversationId ?? null,
      ownerId: t.ownerId ?? null,
      priority: t.priority,
      value: t.value ?? null,
      currency: t.currency,
      createdAt: iso(t.createdAt),
      enteredStageAt: iso(t.enteredStageAt),
      closedAt: iso(t.closedAt),
    },
    contact: await contactRef(db, workspaceId, t.contactId),
  };
}

async function booking(db: Db, workspaceId: string, id: string) {
  const a = await db.appointment.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      contactId: true,
      service: true,
      serviceAr: true,
      serviceId: true,
      staffId: true,
      startAt: true,
      durationMin: true,
      status: true,
      source: true,
      createdAt: true,
    },
  });
  if (!a) return null;
  return {
    booking: {
      id: a.id,
      contactId: a.contactId,
      service: a.service,
      serviceAr: a.serviceAr,
      serviceId: a.serviceId ?? null,
      staffId: a.staffId ?? null,
      startAt: iso(a.startAt),
      durationMin: a.durationMin,
      status: a.status,
      source: a.source,
      createdAt: iso(a.createdAt),
    },
    contact: await contactRef(db, workspaceId, a.contactId),
  };
}

async function message(db: Db, workspaceId: string, id: string) {
  const m = await db.message.findFirst({
    where: { id, workspaceId },
    select: { id: true, body: true, from: true, conversationId: true, createdAt: true, attach: true },
  });
  if (!m) return null;
  const conv = await db.conversation.findFirst({
    where: { id: m.conversationId, workspaceId },
    select: { id: true, channel: true, contactId: true },
  });
  return {
    message: { id: m.id, body: m.body, from: m.from, hasAttachment: !!m.attach, createdAt: iso(m.createdAt) },
    conversation: conv ? { id: conv.id, channel: conv.channel } : { id: m.conversationId },
    contact: await contactRef(db, workspaceId, conv?.contactId),
  };
}

async function assignment(db: Db, workspaceId: string, id: string) {
  const c = await db.conversation.findFirst({
    where: { id, workspaceId },
    select: { id: true, channel: true, contactId: true, assigneeId: true, status: true },
  });
  if (!c) return null;
  const assignee = c.assigneeId ? await db.user.findUnique({ where: { id: c.assigneeId }, select: { id: true, name: true } }) : null;
  return {
    conversation: { id: c.id, channel: c.channel, status: c.status },
    assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
    contact: await contactRef(db, workspaceId, c.contactId),
  };
}

/** The event's `data`, or null when the record is gone (or is another workspace's). */
export async function buildPayload(db: Db, emit: WebhookEmit): Promise<Record<string, unknown> | null> {
  const { workspaceId, entityId } = emit;
  const builders: Record<WebhookEventType, () => Promise<Record<string, unknown> | null>> = {
    "contact.created": async () => {
      const c = await contact(db, workspaceId, entityId);
      return c ? { contact: c } : null;
    },
    "message.received": () => message(db, workspaceId, entityId),
    "ticket.created": () => ticket(db, workspaceId, entityId),
    "ticket.stage_changed": () => ticket(db, workspaceId, entityId),
    "booking.created": () => booking(db, workspaceId, entityId),
    "booking.completed": () => booking(db, workspaceId, entityId),
    "conversation.assigned": () => assignment(db, workspaceId, entityId),
  };
  return builders[emit.type]();
}
