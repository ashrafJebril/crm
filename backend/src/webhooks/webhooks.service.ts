import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../permissions/permission.service";
import { encryptSecret, isTokenEncryptionEnabled } from "../common/token-crypto";
import { parseSafeUrl, redactedUrl, UnsafeUrlError } from "../common/safe-fetch";
import { webhookError } from "./webhook-errors";
import {
  PING_EVENT,
  WEBHOOK_ENDPOINTS_MAX,
  WEBHOOK_EVENTS,
  WEBHOOK_ROTATION_OVERLAP_MS,
  isWebhookEvent,
  randomEventId,
} from "./webhook-events";
import { newWebhookSecret } from "./webhook-signature";

const DESCRIPTION_MAX = 200;
const DELIVERY_PAGE = 50;

export interface WebhookEndpointDto {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  failingSince: Date | null;
  hasPreviousSecret: boolean;
  createdAt: Date;
}

export interface WebhookDeliveryDto {
  id: string;
  eventId: string;
  event: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}

type EndpointRow = {
  id: string;
  workspaceId: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  disabledReason: string | null;
  failingSince: Date | null;
  previousSecretEnc: string | null;
  previousSecretExpiresAt: Date | null;
  createdAt: Date;
};

type DeliveryRow = WebhookDeliveryDto & { workspaceId: string; endpointId: string; payload: unknown };

/** The JSON envelope every delivery carries. */
export function envelope(eventId: string, type: string, workspaceId: string, data: unknown, at: Date) {
  return { id: eventId, type, createdAt: at.toISOString(), workspaceId, data };
}

function deliveryDto(r: DeliveryRow): WebhookDeliveryDto {
  return {
    id: r.id,
    eventId: r.eventId,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    responseCode: r.responseCode ?? null,
    lastError: r.lastError ?? null,
    nextAttemptAt: r.nextAttemptAt,
    deliveredAt: r.deliveredAt ?? null,
    createdAt: r.createdAt,
  };
}

/**
 * SP-27 outgoing webhook endpoints: CRUD, secret rotation (24 h overlap),
 * "Send test" and redelivery. The URL passes the safe-fetch policy at create
 * time and is immutable afterwards. The signing secret is encrypted with
 * TOKEN_ENC_KEY (production refuses without it) and returned only by create
 * and rotate.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  toDto(row: EndpointRow): WebhookEndpointDto {
    const now = this.now();
    return {
      id: row.id,
      url: row.url,
      description: row.description ?? null,
      events: row.events ?? [],
      active: row.active,
      disabledReason: row.disabledReason ?? null,
      failingSince: row.failingSince ?? null,
      hasPreviousSecret: !!row.previousSecretEnc && !!row.previousSecretExpiresAt && row.previousSecretExpiresAt > now,
      createdAt: row.createdAt,
    };
  }

  private async endpoint(workspaceId: string, id: string): Promise<EndpointRow> {
    const row = (await this.prisma.webhookEndpoint.findFirst({ where: { id, workspaceId } })) as EndpointRow | null;
    if (!row) throw webhookError("webhooks.not_found");
    return row;
  }

  private sealSecret(secret: string): string {
    // Production never stores a webhook secret in plain text.
    if (!isTokenEncryptionEnabled() && process.env.NODE_ENV === "production") throw webhookError("webhooks.encryption_unavailable");
    return encryptSecret(secret);
  }

  private events(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((e) => !isWebhookEvent(e))) {
      throw webhookError("webhooks.invalid_events", { allowed: WEBHOOK_EVENTS });
    }
    return WEBHOOK_EVENTS.filter((e) => raw.includes(e));
  }

  private description(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || raw.length > DESCRIPTION_MAX) throw webhookError("webhooks.invalid_description");
    return raw.trim() || null;
  }

  async list(workspaceId: string): Promise<{ items: WebhookEndpointDto[] }> {
    const rows = (await this.prisma.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } })) as EndpointRow[];
    return { items: rows.map((r) => this.toDto(r)) };
  }

  async create(
    workspaceId: string,
    actor: Actor,
    input: { url?: unknown; events?: unknown; description?: unknown },
  ): Promise<WebhookEndpointDto & { secret: string }> {
    let url: string;
    try {
      url = parseSafeUrl(String(input.url ?? "")).toString();
    } catch (e) {
      if (e instanceof UnsafeUrlError) throw webhookError("webhooks.unsafe_url");
      throw e;
    }
    const events = this.events(input.events);
    const description = this.description(input.description);
    const secret = newWebhookSecret();
    const secretEnc = this.sealSecret(secret);
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`webhooks:${workspaceId}`}))`;
        const count = await tx.webhookEndpoint.count({ where: { workspaceId } });
        if (count >= WEBHOOK_ENDPOINTS_MAX) throw webhookError("webhooks.limit_reached", { max: WEBHOOK_ENDPOINTS_MAX });
        const created = await tx.webhookEndpoint.create({
          data: { workspaceId, url, events, description, secretEnc, createdById: actor.isSuperAdmin ? null : actor.userId },
        });
        await this.audit.record(tx, {
          workspaceId,
          actorId: actor.userId,
          action: "webhook.created",
          targetKind: "webhook",
          targetId: created.id,
          meta: { url: redactedUrl(url), events },
        });
        return created;
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
    return { ...this.toDto(row as EndpointRow), secret };
  }

  /** Events, description and the active switch. The URL never changes
   *  (delete and recreate): 400 webhooks.url_immutable. */
  async update(
    workspaceId: string,
    actor: Actor,
    id: string,
    input: { url?: unknown; events?: unknown; description?: unknown; active?: unknown },
  ): Promise<WebhookEndpointDto> {
    if (input.url !== undefined) throw webhookError("webhooks.url_immutable");
    const row = await this.endpoint(workspaceId, id);
    const data: Prisma.WebhookEndpointUpdateManyMutationInput = {};
    if (input.events !== undefined) data.events = this.events(input.events);
    if (input.description !== undefined) data.description = this.description(input.description);
    if (input.active !== undefined) {
      if (typeof input.active !== "boolean") throw webhookError("webhooks.invalid_events");
      if (input.active && !row.active) {
        // Re-enabling re-checks the URL and resets the failure clock.
        try {
          parseSafeUrl(row.url);
        } catch {
          throw webhookError("webhooks.unsafe_url");
        }
        Object.assign(data, { active: true, disabledReason: null, failingSince: null });
      } else if (!input.active && row.active) {
        Object.assign(data, { active: false, disabledReason: "manual" });
      }
    }
    if (Object.keys(data).length) {
      await this.prisma.webhookEndpoint.updateMany({ where: { id, workspaceId }, data });
      await this.audit.record(this.prisma, {
        workspaceId,
        actorId: actor.userId,
        action: "webhook.updated",
        targetKind: "webhook",
        targetId: id,
        meta: { fields: Object.keys(data) },
      });
    }
    return this.toDto(await this.endpoint(workspaceId, id));
  }

  async remove(workspaceId: string, actor: Actor, id: string): Promise<{ ok: true }> {
    const row = await this.endpoint(workspaceId, id);
    await this.prisma.webhookEndpoint.deleteMany({ where: { id, workspaceId } });
    await this.audit.record(this.prisma, {
      workspaceId,
      actorId: actor.userId,
      action: "webhook.deleted",
      targetKind: "webhook",
      targetId: id,
      meta: { url: redactedUrl(row.url) },
    });
    return { ok: true };
  }

  /** A new secret; the old one keeps signing for 24 h (two v1 values). */
  async rotateSecret(workspaceId: string, actor: Actor, id: string): Promise<{ secret: string }> {
    await this.endpoint(workspaceId, id);
    const current = (await this.prisma.webhookEndpoint.findFirst({ where: { id, workspaceId }, select: { secretEnc: true } }))!;
    const secret = newWebhookSecret();
    const secretEnc = this.sealSecret(secret);
    await this.prisma.webhookEndpoint.updateMany({
      where: { id, workspaceId },
      data: {
        secretEnc,
        previousSecretEnc: current.secretEnc,
        previousSecretExpiresAt: new Date(this.now().getTime() + WEBHOOK_ROTATION_OVERLAP_MS),
      },
    });
    await this.audit.record(this.prisma, {
      workspaceId,
      actorId: actor.userId,
      action: "webhook.secret_rotated",
      targetKind: "webhook",
      targetId: id,
    });
    return { secret };
  }

  /** "Send test": a `ping` delivery, sent by the dispatcher's next tick. */
  async test(workspaceId: string, id: string): Promise<{ deliveryId: string }> {
    const row = await this.endpoint(workspaceId, id);
    const now = this.now();
    const eventId = randomEventId();
    const d = await this.prisma.webhookDelivery.create({
      data: {
        workspaceId,
        endpointId: row.id,
        eventId,
        event: PING_EVENT,
        payload: envelope(eventId, PING_EVENT, workspaceId, { endpointId: row.id }, now) as Prisma.InputJsonValue,
        nextAttemptAt: now,
      },
    });
    return { deliveryId: d.id };
  }

  async deliveries(
    workspaceId: string,
    id: string,
    q: { status?: string; cursor?: string },
  ): Promise<{ items: WebhookDeliveryDto[]; nextCursor: string | null }> {
    await this.endpoint(workspaceId, id);
    const status = q.status && ["pending", "delivered", "failed"].includes(q.status) ? q.status : undefined;
    let before: Date | undefined;
    if (q.cursor) {
      const d = new Date(q.cursor);
      if (!Number.isNaN(d.getTime())) before = d;
    }
    const rows = (await this.prisma.webhookDelivery.findMany({
      where: { workspaceId, endpointId: id, ...(status ? { status } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: DELIVERY_PAGE + 1,
    })) as DeliveryRow[];
    const page = rows.slice(0, DELIVERY_PAGE);
    return {
      items: page.map(deliveryDto),
      nextCursor: rows.length > DELIVERY_PAGE ? page[page.length - 1].createdAt.toISOString() : null,
    };
  }

  async delivery(workspaceId: string, id: string, deliveryId: string): Promise<WebhookDeliveryDto & { payload: unknown }> {
    await this.endpoint(workspaceId, id);
    const r = (await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId: id, workspaceId } })) as DeliveryRow | null;
    if (!r) throw webhookError("webhooks.not_found");
    return { ...deliveryDto(r), payload: r.payload };
  }

  /** A new pending row with the same event, id suffixed `:r<n>`. */
  async redeliver(workspaceId: string, id: string, deliveryId: string): Promise<{ deliveryId: string }> {
    await this.endpoint(workspaceId, id);
    const r = (await this.prisma.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId: id, workspaceId } })) as DeliveryRow | null;
    if (!r) throw webhookError("webhooks.not_found");
    const base = r.eventId.replace(/:r\d+$/, "");
    const siblings = await this.prisma.webhookDelivery.count({ where: { endpointId: id, workspaceId, eventId: { startsWith: `${base}:r` } } });
    const d = await this.prisma.webhookDelivery.create({
      data: {
        workspaceId,
        endpointId: id,
        eventId: `${base}:r${siblings + 1}`,
        event: r.event,
        payload: r.payload as Prisma.InputJsonValue,
        nextAttemptAt: this.now(),
      },
    });
    return { deliveryId: d.id };
  }
}
