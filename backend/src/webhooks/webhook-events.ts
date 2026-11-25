import { createHash, randomUUID } from "crypto";

/** SP-27 ruling 4: the subscribable events (v1). */
export const WEBHOOK_EVENTS = [
  "contact.created",
  "conversation.assigned",
  "message.received",
  "ticket.created",
  "ticket.stage_changed",
  "booking.created",
  "booking.completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
/** Test only ("Send test"); never subscribable. */
export const PING_EVENT = "ping";

export const WEBHOOK_BACKOFF_MS = [60e3, 300e3, 1800e3, 7200e3, 28800e3] as const;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_DISABLE_AFTER_MS = 72 * 60 * 60 * 1000;
export const WEBHOOK_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
export const WEBHOOK_ENDPOINTS_MAX = 10;
export const WEBHOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Signatures older or newer than this are rejected by verify() (replay window). */
export const WEBHOOK_TOLERANCE_S = 300;

/** The internal emitter event for webhook-only emits (booking.created,
 *  conversation.assigned). The other five come from WORKFLOW_TRIGGER_EVENT. */
export const WEBHOOK_EVENT = "webhook.event";

export interface WebhookEmit {
  workspaceId: string;
  type: WebhookEventType;
  /** The record the payload is re-read from. */
  entityId: string;
  /** What makes this occurrence unique (e.g. a version); defaults to entityId. */
  occurrence?: string;
}

const SET = new Set<string>(WEBHOOK_EVENTS);
export function isWebhookEvent(v: unknown): v is WebhookEventType {
  return typeof v === "string" && SET.has(v);
}

/** Deterministic per occurrence, so a duplicate emit is a no-op
 *  (@@unique([endpointId, eventId])). */
export function eventIdFor(workspaceId: string, type: string, occurrence: string): string {
  return `evt_${createHash("sha256").update(`${workspaceId}|${type}|${occurrence}`).digest("hex").slice(0, 32)}`;
}

export function randomEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

/** WORKFLOW_TRIGGER_EVENT → webhook event, from the trigger's payload. */
export function fromWorkflowTrigger(e: { workspaceId?: unknown; triggerType?: unknown; payload?: unknown }): WebhookEmit | null {
  if (typeof e?.workspaceId !== "string" || typeof e.triggerType !== "string") return null;
  const p = (e.payload ?? {}) as Record<string, any>;
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (e.triggerType) {
    case "contact_created": {
      const cid = id(p.contact?.id);
      return cid ? { workspaceId: e.workspaceId, type: "contact.created", entityId: cid } : null;
    }
    case "message_received": {
      const mid = id(p.message?.id);
      return mid ? { workspaceId: e.workspaceId, type: "message.received", entityId: mid } : null;
    }
    case "ticket_created": {
      const tid = id(p.ticket?.id);
      return tid ? { workspaceId: e.workspaceId, type: "ticket.created", entityId: tid } : null;
    }
    case "ticket_stage_changed": {
      const tid = id(p.ticket?.id);
      if (!tid) return null;
      const stage = id(p.ticket?.stageId) ?? "";
      const at = p.ticket?.enteredStageAt ? new Date(p.ticket.enteredStageAt).toISOString() : "";
      return { workspaceId: e.workspaceId, type: "ticket.stage_changed", entityId: tid, occurrence: `${tid}:${stage}:${at}` };
    }
    case "appointment_completed": {
      const aid = id(p.appointment?.id);
      return aid ? { workspaceId: e.workspaceId, type: "booking.completed", entityId: aid } : null;
    }
    default:
      return null;
  }
}
