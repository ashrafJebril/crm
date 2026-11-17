import { Injectable, Logger, Optional } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PermissionService } from "../permissions/permission.service";
import { NotificationsService } from "../notifications/notifications.service";
import { decryptSecret } from "../common/token-crypto";
import { defaultSafeDeps, redactedUrl, safePost, UnsafeUrlError, type SafeFetchDeps } from "../common/safe-fetch";
import { WEBHOOK_BACKOFF_MS, WEBHOOK_DISABLE_AFTER_MS, WEBHOOK_MAX_ATTEMPTS } from "./webhook-events";
import { SIGNATURE_HEADER, sign } from "./webhook-signature";

export const DISPATCH_BATCH = 50;
export const LEASE_MS = 60_000;
export const LAST_ERROR_MAX = 300;
export const WEBHOOK_DISABLED_TITLE = "webhooks.endpoint_disabled";
export const WEBHOOK_ALERT_PERMISSION = "api_keys.manage";

type Due = { id: string; workspaceId: string };
type DeliveryRow = {
  id: string;
  workspaceId: string;
  endpointId: string;
  eventId: string;
  event: string;
  payload: unknown;
  status: string;
  attempts: number;
};
type EndpointRow = {
  id: string;
  workspaceId: string;
  url: string;
  active: boolean;
  secretEnc: string;
  previousSecretEnc: string | null;
  previousSecretExpiresAt: Date | null;
  failingSince: Date | null;
};

/**
 * SP-27 delivery. Every 10 s: up to 50 due pending rows, each claimed with a
 * conditional lease (the workflow-poller pattern: two dispatchers, here or on
 * another machine, never send the same attempt), then signed and POSTed
 * through safePost. 2xx → delivered. Anything else → retried at 1 m, 5 m,
 * 30 m, 2 h, 8 h; the 6th failure is final. The endpoint's `failingSince`
 * starts at its first failure and clears on a success; after 72 h of failure
 * the endpoint is disabled and members with api_keys.manage get one
 * `connector_needs_attention`. An unsafe URL at send time disables it at once.
 * A payment-locked workspace's rows wait (untouched) until the lock clears.
 * No response body is stored; lastError is a short reason (≤ 300 chars).
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private running = false;
  now: () => Date = () => new Date();
  transport: SafeFetchDeps = defaultSafeDeps();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly paymentLock?: PaymentLockService,
    @Optional() private readonly perms?: PermissionService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  @Interval(10_000)
  async scheduled(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (e) {
      this.logger.warn(`webhook dispatch tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass; returns how many attempts this dispatcher made. */
  async tick(): Promise<number> {
    const now = this.now();
    const due = (await this.prisma.webhookDelivery.findMany({
      where: { status: "pending", nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      orderBy: { nextAttemptAt: "asc" },
      take: DISPATCH_BATCH,
      select: { id: true, workspaceId: true },
    })) as Due[];
    const locked = new Map<string, boolean>();
    let sent = 0;
    for (const d of due) {
      if (!locked.has(d.workspaceId)) locked.set(d.workspaceId, await this.isLocked(d.workspaceId));
      if (locked.get(d.workspaceId)) continue;
      const claimed = await this.prisma.webhookDelivery.updateMany({
        where: { id: d.id, status: "pending", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (claimed.count === 0) continue;
      try {
        if (await this.attempt(d.id)) sent++;
      } catch (e) {
        this.logger.warn(`webhook delivery ${d.id} failed to process: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async isLocked(workspaceId: string): Promise<boolean> {
    if (!this.paymentLock) return false;
    try {
      return await this.paymentLock.isLocked(workspaceId);
    } catch {
      return true; // unknown → wait
    }
  }

  /** One claimed attempt; true when a request was made. */
  private async attempt(id: string): Promise<boolean> {
    const row = (await this.prisma.webhookDelivery.findFirst({ where: { id } })) as DeliveryRow | null;
    if (!row || row.status !== "pending") return false;
    const ep = (await this.prisma.webhookEndpoint.findFirst({
      where: { id: row.endpointId, workspaceId: row.workspaceId },
    })) as EndpointRow | null;
    const now = this.now();
    if (!ep || !ep.active) {
      await this.finish(row.id, { status: "failed", lastError: "endpoint_disabled", leaseUntil: null });
      return false;
    }

    const secrets = [decryptSecret(ep.secretEnc)];
    if (ep.previousSecretEnc && ep.previousSecretExpiresAt && ep.previousSecretExpiresAt > now) {
      secrets.push(decryptSecret(ep.previousSecretEnc));
    }
    const body = JSON.stringify(row.payload);
    const t = Math.floor(now.getTime() / 1000);
    const envelopeId = (row.payload as { id?: unknown } | null)?.id;
    const attemptNo = row.attempts + 1;
    const headers = {
      "content-type": "application/json",
      "user-agent": "AramCRM-Webhooks/1",
      [SIGNATURE_HEADER.toLowerCase()]: sign(secrets, t, body),
      "x-crm-event": row.event,
      "x-crm-event-id": typeof envelopeId === "string" ? envelopeId : row.eventId,
      "x-crm-delivery-attempt": String(attemptNo),
    };

    let result: { ok: boolean; status: number; error: string | null };
    try {
      result = await safePost(ep.url, body, headers, this.transport);
    } catch (e) {
      if (!(e instanceof UnsafeUrlError)) throw e;
      await this.finish(row.id, { status: "failed", attempts: attemptNo, lastError: "unsafe_url", leaseUntil: null });
      await this.disable(ep, "unsafe_url");
      return false;
    }

    if (result.ok) {
      await this.finish(row.id, {
        status: "delivered",
        attempts: attemptNo,
        responseCode: result.status,
        deliveredAt: this.now(),
        lastError: null,
        leaseUntil: null,
      });
      await this.prisma.webhookEndpoint.updateMany({ where: { id: ep.id, NOT: { failingSince: null } }, data: { failingSince: null } });
      return true;
    }

    const final = attemptNo >= WEBHOOK_MAX_ATTEMPTS;
    await this.finish(row.id, {
      status: final ? "failed" : "pending",
      attempts: attemptNo,
      responseCode: result.status || null,
      lastError: (result.error ?? "failed").slice(0, LAST_ERROR_MAX),
      leaseUntil: null,
      ...(final ? {} : { nextAttemptAt: new Date(now.getTime() + WEBHOOK_BACKOFF_MS[attemptNo - 1]) }),
    });
    const since = ep.failingSince ?? now;
    if (!ep.failingSince) {
      await this.prisma.webhookEndpoint.updateMany({ where: { id: ep.id, failingSince: null }, data: { failingSince: now } });
    }
    if (now.getTime() - since.getTime() >= WEBHOOK_DISABLE_AFTER_MS) await this.disable(ep, "failing");
    return true;
  }

  private finish(id: string, data: Record<string, unknown>) {
    return this.prisma.webhookDelivery.updateMany({ where: { id, status: "pending" }, data });
  }

  /** Disables once (conditional on still active) and notifies only then. */
  private async disable(ep: EndpointRow, reason: "failing" | "unsafe_url"): Promise<void> {
    const res = await this.prisma.webhookEndpoint.updateMany({
      where: { id: ep.id, workspaceId: ep.workspaceId, active: true },
      data: { active: false, disabledReason: reason },
    });
    if (res.count === 0) return;
    this.logger.warn(`webhook endpoint ${ep.id} disabled (${reason}): ${redactedUrl(ep.url)}`);
    if (!this.perms || !this.notifications) return;
    try {
      const userIds = await this.perms.membersWith(ep.workspaceId, WEBHOOK_ALERT_PERMISSION);
      await this.notifications.notify(ep.workspaceId, userIds, {
        type: "connector_needs_attention",
        title: WEBHOOK_DISABLED_TITLE,
        body: JSON.stringify({ endpointId: ep.id, url: redactedUrl(ep.url), reason }),
      });
    } catch (e) {
      this.logger.warn(`webhook disable notification failed: ${(e as Error).message}`);
    }
  }
}
