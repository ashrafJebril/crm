import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WORKFLOW_TRIGGER_EVENT } from "../workflows/workflow-events";
import { WEBHOOK_EVENT, eventIdFor, fromWorkflowTrigger, isWebhookEvent, type WebhookEmit } from "./webhook-events";
import { buildPayload } from "./webhook-payloads";
import { envelope } from "./webhooks.service";

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";
}

/**
 * SP-27 producer. Every emit point fires AFTER its write committed; this
 * listener runs asynchronously (`async: true`), so it never delays or fails
 * the request. For each active endpoint of the event's workspace subscribed
 * to the event it inserts one pending WebhookDelivery whose payload is built
 * by re-reading the record by (id, workspaceId) through the whitelisting
 * serializers. The event id is deterministic per occurrence and
 * @@unique([endpointId, eventId]) makes a duplicate emit a no-op.
 */
@Injectable()
export class WebhookOutboxListener {
  private readonly logger = new Logger(WebhookOutboxListener.name);
  now: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(WORKFLOW_TRIGGER_EVENT, { async: true })
  async onWorkflowTrigger(e: unknown): Promise<void> {
    const emit = fromWorkflowTrigger(e as never);
    if (emit) await this.enqueue(emit);
  }

  @OnEvent(WEBHOOK_EVENT, { async: true })
  async onWebhookEvent(e: WebhookEmit): Promise<void> {
    if (e && typeof e.workspaceId === "string" && isWebhookEvent(e.type) && typeof e.entityId === "string") await this.enqueue(e);
  }

  /** Never throws (a webhook must not affect the emitting write). */
  async enqueue(emit: WebhookEmit): Promise<number> {
    try {
      const endpoints = (
        await this.prisma.webhookEndpoint.findMany({
          where: { workspaceId: emit.workspaceId, active: true },
          select: { id: true, workspaceId: true, events: true },
        })
      ).filter((ep) => ep.workspaceId === emit.workspaceId && (ep.events ?? []).includes(emit.type));
      if (!endpoints.length) return 0;
      const data = await buildPayload(this.prisma, emit);
      if (!data) return 0;
      const now = this.now();
      const eventId = eventIdFor(emit.workspaceId, emit.type, emit.occurrence ?? emit.entityId);
      const payload = envelope(eventId, emit.type, emit.workspaceId, data, now) as Prisma.InputJsonValue;
      let inserted = 0;
      for (const ep of endpoints) {
        try {
          await this.prisma.webhookDelivery.create({
            data: { workspaceId: emit.workspaceId, endpointId: ep.id, eventId, event: emit.type, payload, nextAttemptAt: now },
          });
          inserted++;
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
        }
      }
      return inserted;
    } catch (e) {
      this.logger.warn(`webhook enqueue failed (${emit.type}, workspace ${emit.workspaceId}): ${(e as Error).message}`);
      return 0;
    }
  }
}
