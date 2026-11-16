import { Injectable } from "@nestjs/common";
import type { Prisma, Service } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { bookingError } from "../bookings/booking-errors";
import { lockResource, lockService } from "../bookings/booking-locks";
import {
  BLOCKING_STATUSES,
  parseColor,
  parseCurrency,
  parseDuration,
  parseIds,
  parseName,
  parseOptionalName,
  parsePrice,
  priceOut,
} from "../bookings/catalog-fields";
import { nameMatches } from "../bookings/names";
import type { CreateServiceDto, ServiceDto, UpdateServiceDto } from "./services.dto";

/**
 * SP-10 services catalog. Every query is scoped by workspaceId; a foreign or
 * unknown id is 404 `bookings.service_not_found`. Deleting a service that any
 * booking references archives it instead (Review Focus 2).
 */
@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, opts: { active?: boolean; q?: string } = {}): Promise<{ items: ServiceDto[] }> {
    const rows = await this.prisma.service.findMany({
      where: { workspaceId, active: opts.active },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    const hit = opts.q ? rows.filter((r) => nameMatches(opts.q as string, r.name, r.nameAr)) : rows;
    return { items: await this.toDtos(workspaceId, hit) };
  }

  async get(workspaceId: string, id: string): Promise<ServiceDto> {
    const [dto] = await this.toDtos(workspaceId, [await this.find(workspaceId, id)]);
    return dto;
  }

  async create(workspaceId: string, dto: CreateServiceDto): Promise<ServiceDto> {
    const name = parseOptionalName(dto.name) ?? parseName(dto.nameAr);
    const nameAr = parseOptionalName(dto.nameAr) ?? name;
    const data = {
      workspaceId,
      name,
      nameAr,
      durationMin: parseDuration(dto.durationMin),
      price: parsePrice(dto.price),
      ...(dto.color !== undefined ? { color: parseColor(dto.color) } : {}),
      ...(dto.currency !== undefined ? { currency: parseCurrency(dto.currency) } : {}),
      order: dto.order ?? (await this.prisma.service.count({ where: { workspaceId } })),
    };
    const staffIds = dto.staffIds === undefined ? [] : parseIds(dto.staffIds, "staffIds");
    const row = await this.prisma.$transaction(async (tx) => {
      // Review M4: the linked resources are checked under their locks.
      await this.lockAndAssertResources(tx, workspaceId, staffIds);
      const created = await tx.service.create({ data });
      if (staffIds.length) {
        await tx.staffService.createMany({
          data: staffIds.map((resourceId) => ({ resourceId, serviceId: created.id, workspaceId })),
        });
      }
      return created;
    });
    return this.get(workspaceId, row.id);
  }

  async update(workspaceId: string, id: string, dto: UpdateServiceDto): Promise<ServiceDto> {
    const row = await this.find(workspaceId, id);
    if (dto.version !== undefined && dto.version !== row.version) throw await this.conflict(workspaceId, row);
    const data: Prisma.ServiceUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = parseName(dto.name);
    if (dto.nameAr !== undefined) data.nameAr = parseName(dto.nameAr);
    if (dto.durationMin !== undefined) data.durationMin = parseDuration(dto.durationMin);
    if (dto.price !== undefined) data.price = parsePrice(dto.price);
    if (dto.color !== undefined) data.color = parseColor(dto.color);
    if (dto.currency !== undefined) data.currency = parseCurrency(dto.currency);
    if (dto.order !== undefined) data.order = dto.order;
    if (dto.active !== undefined) {
      if (row.archivedAt && dto.active) throw bookingError("bookings.service_archived");
      data.active = dto.active;
    }
    // Compare-and-set on version, so two concurrent edits cannot both win.
    const { count } = await this.prisma.service.updateMany({
      where: { id, workspaceId, version: dto.version ?? row.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) throw await this.conflict(workspaceId, await this.find(workspaceId, id));
    return this.get(workspaceId, id);
  }

  /** Replaces the staff links (`PUT /services/:id/staff`). Unknown/foreign ids → 404. */
  async setStaff(workspaceId: string, id: string, staffIdsIn: unknown): Promise<ServiceDto> {
    await this.find(workspaceId, id);
    const staffIds = parseIds(staffIdsIn, "staffIds");
    await this.prisma.$transaction(async (tx) => {
      // Review M4: lock order service → resources (booking-locks.ts), then
      // re-check every row inside the transaction, so a concurrent delete is a
      // 404 and a concurrent archive is the archived key, never a 500.
      await lockService(tx, id);
      if (!(await tx.service.findFirst({ where: { id, workspaceId }, select: { id: true } }))) {
        throw bookingError("bookings.service_not_found");
      }
      await this.lockAndAssertResources(tx, workspaceId, staffIds);
      await tx.staffService.deleteMany({ where: { serviceId: id, workspaceId } });
      if (staffIds.length) {
        await tx.staffService.createMany({
          data: staffIds.map((resourceId) => ({ resourceId, serviceId: id, workspaceId })),
          skipDuplicates: true,
        });
      }
    });
    return this.get(workspaceId, id);
  }

  async deletePreview(workspaceId: string, id: string): Promise<{ bookingCount: number; upcomingCount: number; staffCount: number }> {
    await this.find(workspaceId, id);
    const [bookingCount, upcomingCount, staffCount] = await Promise.all([
      this.prisma.appointment.count({ where: { workspaceId, serviceId: id } }),
      this.prisma.appointment.count({
        where: { workspaceId, serviceId: id, status: { in: [...BLOCKING_STATUSES] }, startAt: { gte: new Date() } },
      }),
      this.prisma.staffService.count({ where: { workspaceId, serviceId: id } }),
    ]);
    return { bookingCount, upcomingCount, staffCount };
  }

  /**
   * Any booking referencing the service (any status) → archive (inactive,
   * archivedAt set, staff links kept). None → hard delete (links cascade).
   * Runs under the service's advisory lock: a booking writer takes the same
   * lock, so a concurrent booking is either counted here or refused with
   * `bookings.service_archived` there.
   */
  async remove(workspaceId: string, id: string): Promise<{ deleted: true } | { archived: true; bookingCount: number }> {
    await this.find(workspaceId, id);
    return this.prisma.$transaction(async (tx) => {
      await lockService(tx, id);
      const row = await tx.service.findFirst({ where: { id, workspaceId } });
      if (!row) throw bookingError("bookings.service_not_found");
      const bookingCount = await tx.appointment.count({ where: { workspaceId, serviceId: id } });
      if (bookingCount > 0) {
        await tx.service.updateMany({
          where: { id, workspaceId },
          data: { active: false, archivedAt: row.archivedAt ?? new Date(), version: { increment: 1 } },
        });
        return { archived: true as const, bookingCount };
      }
      await tx.service.deleteMany({ where: { id, workspaceId } });
      return { deleted: true as const };
    });
  }

  /** Reactivates an archived (or paused) service. */
  async restore(workspaceId: string, id: string): Promise<ServiceDto> {
    await this.find(workspaceId, id);
    await this.prisma.service.updateMany({
      where: { id, workspaceId },
      data: { active: true, archivedAt: null, version: { increment: 1 } },
    });
    return this.get(workspaceId, id);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async find(workspaceId: string, id: string): Promise<Service> {
    const row = await this.prisma.service.findFirst({ where: { id, workspaceId } });
    if (!row) throw bookingError("bookings.service_not_found");
    return row;
  }

  private async conflict(workspaceId: string, row: Service) {
    const [current] = await this.toDtos(workspaceId, [row]);
    return bookingError("bookings.version_conflict", { current });
  }

  /** Locks each resource (sorted, after any service lock), then: every id must be a non-archived resource of this workspace. */
  private async lockAndAssertResources(tx: Pick<PrismaService, "staffResource" | "$executeRaw">, workspaceId: string, ids: string[]) {
    if (!ids.length) return;
    for (const rid of [...ids].sort()) await lockResource(tx, rid);
    const found = await tx.staffResource.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, archivedAt: true },
    });
    if (found.length !== ids.length) throw bookingError("bookings.resource_not_found");
    if (found.some((r) => r.archivedAt)) throw bookingError("bookings.resource_archived");
  }

  private async toDtos(workspaceId: string, rows: Service[]): Promise<ServiceDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [links, upcoming] = await Promise.all([
      this.prisma.staffService.findMany({
        where: { workspaceId, serviceId: { in: ids } },
        select: { serviceId: true, resourceId: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.appointment.groupBy({
        by: ["serviceId"],
        where: {
          workspaceId,
          serviceId: { in: ids },
          status: { in: [...BLOCKING_STATUSES] },
          startAt: { gte: new Date() },
        },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(upcoming.map((g) => [g.serviceId, g._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nameAr: r.nameAr,
      color: r.color,
      durationMin: r.durationMin,
      price: priceOut(r.price),
      currency: r.currency,
      active: r.active,
      archivedAt: r.archivedAt,
      order: r.order,
      version: r.version,
      staffIds: links.filter((l) => l.serviceId === r.id).map((l) => l.resourceId),
      upcomingCount: counts.get(r.id) ?? 0,
    }));
  }
}
