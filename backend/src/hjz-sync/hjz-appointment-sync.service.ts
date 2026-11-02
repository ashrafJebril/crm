import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import type { Appointment } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { hjzWebhookUrl, postToHjz } from "./hjz-api";

/** A refused or failed push is retried after this long, not on every sweep. */
const RETRY_AFTER_MS = 15 * 60 * 1000;
const SWEEP_BATCH = 50;

/**
 * CRM bookings → HJZ appointments for workspaces connected to HJZ.
 *
 * Every create / reschedule / status change marks the booking
 * `hjzSyncPending` and pushes its FULL current state; HJZ upserts on the CRM
 * booking id, so a retry or an out-of-order push can't double-book. A
 * one-minute sweep retries what failed. HJZ resolves the service by name,
 * the branch and a free team member itself; when it can't (e.g. no HJZ
 * service with that name) its reason is kept in `hjzSyncError`.
 */
@Injectable()
export class HjzAppointmentSyncService {
  private readonly logger = new Logger(HjzAppointmentSyncService.name);
  private sweeping = false;

  constructor(private readonly prisma: PrismaService) {}

  isConfigured(): boolean {
    return hjzWebhookUrl("appointments") !== null;
  }

  /** Mark a booking changed and push it now. Never throws. */
  async changed(appointmentId: string): Promise<void> {
    try {
      await this.prisma.raw.appointment.update({
        where: { id: appointmentId },
        data: { hjzSyncPending: true, hjzSyncAttemptAt: null },
      });
      await this.push(appointmentId);
    } catch (e: unknown) {
      this.logger.warn(`hjz appointment ${appointmentId} mark/push failed: ${msg(e)}`);
    }
  }

  /**
   * A booking about to be deleted: tell HJZ it is cancelled. Deletion is
   * final in the CRM, so this is the one push that is not retried.
   */
  async deleted(appt: Appointment): Promise<void> {
    if (!appt.hjzAppointmentId || !this.isConfigured()) return;
    try {
      const payload = await this.payload({ ...appt, status: "cancelled" });
      if (payload) await postToHjz("appointments", payload);
    } catch (e: unknown) {
      this.logger.warn(`hjz cancel for deleted appointment ${appt.id} failed: ${msg(e)}`);
    }
  }

  async push(appointmentId: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    // Claim: pending and not tried recently. Two pushes (or app instances)
    // never send the same change at once.
    const claimed = await this.prisma.raw.appointment.updateMany({
      where: {
        id: appointmentId,
        hjzSyncPending: true,
        OR: [{ hjzSyncAttemptAt: null }, { hjzSyncAttemptAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }],
      },
      data: { hjzSyncAttemptAt: new Date() },
    });
    if (claimed.count === 0) return false;

    const appt = await this.prisma.raw.appointment.findUnique({ where: { id: appointmentId } });
    if (!appt) return false;
    const payload = await this.payload(appt);
    if (!payload) {
      // Workspace not connected (any more) — nothing to sync.
      await this.prisma.raw.appointment.update({ where: { id: appt.id }, data: { hjzSyncPending: false } });
      return false;
    }

    try {
      const res = await postToHjz("appointments", payload);
      const body = (res.body ?? {}) as { appointmentId?: string | null; clientId?: string | null; code?: string; message?: string };
      if (!res.ok) {
        const error = (body.code ?? `HTTP ${res.status}`) + (body.message ? `: ${body.message}` : "");
        await this.prisma.raw.appointment.update({ where: { id: appt.id }, data: { hjzSyncError: error.slice(0, 500) } });
        this.logger.warn(`hjz appointment ${appt.id} refused: ${error}`);
        return false;
      }
      // A change made while this push was in flight re-marked the row with a
      // newer updatedAt — leave it pending so the sweep sends that too.
      await this.prisma.raw.appointment.updateMany({
        where: { id: appt.id, updatedAt: appt.updatedAt },
        data: { hjzSyncPending: false, hjzSyncError: null },
      });
      if (body.appointmentId && body.appointmentId !== appt.hjzAppointmentId) {
        await this.prisma.raw.appointment.update({ where: { id: appt.id }, data: { hjzAppointmentId: body.appointmentId } });
      }
      if (body.clientId) {
        await this.prisma.raw.contact.updateMany({
          where: { id: appt.contactId, hjzClientId: null },
          data: { hjzClientId: body.clientId },
        }).catch(() => undefined); // another contact already holds that link — keep the booking result
      }
      return true;
    } catch (e: unknown) {
      await this.prisma.raw.appointment
        .update({ where: { id: appt.id }, data: { hjzSyncError: `unreachable: ${msg(e)}`.slice(0, 500) } })
        .catch(() => undefined);
      return false;
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (!this.isConfigured() || this.sweeping) return;
    this.sweeping = true;
    try {
      const pending = await this.prisma.raw.appointment.findMany({
        where: {
          hjzSyncPending: true,
          OR: [{ hjzSyncAttemptAt: null }, { hjzSyncAttemptAt: { lt: new Date(Date.now() - RETRY_AFTER_MS) } }],
          workspace: { externalTenantId: { not: null } },
        },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: SWEEP_BATCH,
      });
      for (const a of pending) await this.push(a.id);
    } catch (e: unknown) {
      this.logger.warn(`hjz appointment sweep failed: ${msg(e)}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async payload(appt: Appointment) {
    const [ws, contact, staff] = await Promise.all([
      this.prisma.raw.workspace.findUnique({ where: { id: appt.workspaceId }, select: { externalTenantId: true } }),
      this.prisma.raw.contact.findUnique({
        where: { id: appt.contactId },
        select: { id: true, name: true, phone: true, hjzClientId: true },
      }),
      appt.staffId
        ? this.prisma.raw.user.findUnique({ where: { id: appt.staffId }, select: { externalId: true, kewyAccountId: true } })
        : null,
    ]);
    if (!ws?.externalTenantId || !contact) return null;
    return {
      event: "appointment.upserted",
      appointment: {
        id: appt.id,
        tenantId: ws.externalTenantId,
        contact,
        service: appt.service,
        serviceAr: appt.serviceAr,
        startAt: appt.startAt.toISOString(),
        durationMin: appt.durationMin,
        status: appt.status,
        note: appt.note,
        // externalId is the HJZ user id, set only by HJZ → CRM SSO.
        staff: staff ? { hjzUserId: staff.externalId, kewyAccountId: staff.kewyAccountId } : null,
      },
    };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
