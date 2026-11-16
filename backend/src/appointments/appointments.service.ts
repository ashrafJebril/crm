import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { HjzAppointmentSyncService } from "../hjz-sync/hjz-appointment-sync.service";
import { BookingWriter, type BookingCreateInput, type BookingUpdateInput, type WriteOpts } from "../bookings/booking-writer";
import { BookingsService } from "../bookings/bookings.service";
import { bookingError } from "../bookings/booking-errors";
import { MAX_LIST_RANGE_DAYS } from "../bookings/booking-constants";

export const LIST_LIMIT_MAX = 500;

export interface ListAppointmentsOpts {
  from?: string;
  to?: string;
  /** One status, or several comma-separated. */
  status?: string;
  serviceId?: string;
  resourceId?: string;
  limit?: number;
}

@Injectable()
export class AppointmentsService {
  private readonly writer: BookingWriter;
  private readonly bookings: BookingsService;

  constructor(
    private readonly prisma: PrismaService,
    // Connected to HJZ → every booking change is mirrored there (no-op otherwise).
    @Optional() private readonly hjzSync?: HjzAppointmentSyncService,
    @Optional() private readonly events?: EventEmitter2,
  ) {
    // SP-10: every create/update goes through the one booking writer (REST and MCP).
    this.writer = new BookingWriter(prisma, hjzSync, events);
    this.bookings = new BookingsService(prisma);
  }

  /**
   * With no options: every booking of the workspace, as before, plus the
   * SP-10 fields (`serviceId`, `resourceId`, `version`, `conflict`, `fit`).
   * With both `from` and `to`, the span must be ≤ MAX_LIST_RANGE_DAYS.
   */
  async list(workspaceId: string, opts: ListAppointmentsOpts = {}) {
    const from = opts.from ? new Date(opts.from) : undefined;
    const to = opts.to ? new Date(opts.to) : undefined;
    if ((from && isNaN(from.getTime())) || (to && isNaN(to.getTime()))) throw bookingError("bookings.range_invalid");
    if (from && to) {
      const span = to.getTime() - from.getTime();
      if (span < 0 || span > MAX_LIST_RANGE_DAYS * 86_400_000) {
        throw bookingError("bookings.range_invalid", { maxDays: MAX_LIST_RANGE_DAYS });
      }
    }
    const statuses = opts.status?.split(",").map((s) => s.trim()).filter(Boolean);
    const where: Prisma.AppointmentWhereInput = {
      workspaceId,
      startAt: from || to ? { gte: from, lte: to } : undefined,
      status: statuses && statuses.length > 1 ? { in: statuses } : statuses?.[0],
      serviceId: opts.serviceId,
      resourceId: opts.resourceId,
    };
    const rows = await this.prisma.appointment.findMany({
      where,
      orderBy: { startAt: "asc" },
      take: opts.limit !== undefined ? Math.min(opts.limit, LIST_LIMIT_MAX) : undefined,
    });
    const complete = !from && !to && !opts.status && !opts.serviceId && !opts.resourceId && opts.limit === undefined;
    return this.bookings.annotate(workspaceId, rows, { complete });
  }

  /**
   * One booking with `conflict`/`fit`, plus its catalog links:
   * `serviceRef: {id, name, nameAr, color} | null` and
   * `resource: {id, name, nameAr} | null`. `service` stays the name snapshot.
   */
  async get(workspaceId: string, id: string) {
    const row = await this.prisma.appointment.findFirst({
      where: { id, workspaceId },
    });
    if (!row) throw new NotFoundException("Appointment not found");
    const [[annotated], serviceRef, resource] = await Promise.all([
      this.bookings.annotate(workspaceId, [row]),
      row.serviceId
        ? this.prisma.service.findFirst({
            where: { id: row.serviceId, workspaceId },
            select: { id: true, name: true, nameAr: true, color: true },
          })
        : null,
      row.resourceId
        ? this.prisma.staffResource.findFirst({
            where: { id: row.resourceId, workspaceId },
            select: { id: true, name: true, nameAr: true },
          })
        : null,
    ]);
    return { ...annotated, serviceRef: serviceRef ?? null, resource: resource ?? null };
  }

  search(workspaceId: string, q: string | undefined) {
    return this.bookings.search(workspaceId, q);
  }

  create(workspaceId: string, dto: BookingCreateInput, opts: WriteOpts = {}) {
    return this.writer.create(workspaceId, dto, opts);
  }

  update(workspaceId: string, id: string, dto: BookingUpdateInput, opts: WriteOpts = {}) {
    return this.writer.update(workspaceId, id, dto, opts);
  }

  async remove(workspaceId: string, id: string) {
    const existing = await this.prisma.appointment.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException("Appointment not found");
    await this.hjzSync?.deleted(existing);
    await this.prisma.appointment.delete({ where: { id } });
    return { ok: true };
  }
}
