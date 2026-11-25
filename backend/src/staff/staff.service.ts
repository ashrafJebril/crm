import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma, type StaffResource } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { bookingError } from "../bookings/booking-errors";
import { lockResource, lockService } from "../bookings/booking-locks";
import { BLOCKING_STATUSES, parseColor, parseIds, parseName, parseOptionalName, parseRole } from "../bookings/catalog-fields";
import { nameMatches } from "../bookings/names";
import { isConfigured, readSchedule, validateSchedule } from "../bookings/schedule";
import type { CreateStaffDto, StaffResourceDto, UpdateStaffDto } from "./staff.dto";

/**
 * SP-10 staff resources. Every query is scoped by workspaceId; a foreign or
 * unknown id is 404 `bookings.resource_not_found`. A resource may link one
 * workspace member (one resource per member). Deleting a resource that any
 * booking references archives it instead (Review Focus 2).
 */
@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, opts: { active?: boolean; q?: string } = {}): Promise<{ items: StaffResourceDto[] }> {
    const rows = await this.prisma.staffResource.findMany({
      where: { workspaceId, active: opts.active },
      orderBy: [{ createdAt: "asc" }],
    });
    const hit = opts.q ? rows.filter((r) => nameMatches(opts.q as string, r.name, r.nameAr)) : rows;
    return { items: await this.toDtos(workspaceId, hit) };
  }

  async get(workspaceId: string, id: string): Promise<StaffResourceDto> {
    const [dto] = await this.toDtos(workspaceId, [await this.find(workspaceId, id)]);
    return dto;
  }

  async create(workspaceId: string, dto: CreateStaffDto): Promise<StaffResourceDto> {
    const data = {
      workspaceId,
      name: parseName(dto.name),
      nameAr: parseOptionalName(dto.nameAr),
      role: parseRole(dto.role),
      ...(dto.color !== undefined ? { color: parseColor(dto.color) } : {}),
      schedule: (dto.schedule === undefined ? {} : validateSchedule(dto.schedule)) as Prisma.InputJsonValue,
      userId: await this.memberOrNull(workspaceId, dto.userId, null),
    };
    const serviceIds = dto.serviceIds === undefined ? [] : parseIds(dto.serviceIds, "serviceIds");
    const row = await this.uniqueMember(workspaceId, data.userId, () =>
      this.prisma.$transaction(async (tx) => {
        // Review M4: the linked services are checked under their locks.
        await this.lockAndAssertServices(tx, workspaceId, serviceIds);
        const created = await tx.staffResource.create({ data });
        if (serviceIds.length) {
          await tx.staffService.createMany({
            data: serviceIds.map((serviceId) => ({ resourceId: created.id, serviceId, workspaceId })),
          });
        }
        return created;
      }),
    );
    return this.get(workspaceId, row.id);
  }

  async update(workspaceId: string, id: string, dto: UpdateStaffDto): Promise<StaffResourceDto> {
    const row = await this.find(workspaceId, id);
    if (dto.version !== undefined && dto.version !== row.version) throw await this.conflict(workspaceId, row);
    const data: Prisma.StaffResourceUncheckedUpdateManyInput = {};
    if (dto.name !== undefined) data.name = parseName(dto.name);
    if (dto.nameAr !== undefined) data.nameAr = parseOptionalName(dto.nameAr);
    if (dto.role !== undefined) data.role = parseRole(dto.role);
    if (dto.color !== undefined) data.color = parseColor(dto.color);
    if (dto.schedule !== undefined) data.schedule = validateSchedule(dto.schedule) as Prisma.InputJsonValue;
    if (dto.userId !== undefined) data.userId = await this.memberOrNull(workspaceId, dto.userId, id);
    if (dto.active !== undefined) {
      if (row.archivedAt && dto.active) throw bookingError("bookings.resource_archived");
      data.active = dto.active;
    }
    const { count } = await this.uniqueMember(workspaceId, (data.userId as string | null | undefined) ?? null, () =>
      this.prisma.staffResource.updateMany({
        where: { id, workspaceId, version: dto.version ?? row.version },
        data: { ...data, version: { increment: 1 } },
      }),
    );
    if (count === 0) throw await this.conflict(workspaceId, await this.find(workspaceId, id));
    return this.get(workspaceId, id);
  }

  /** Replaces the services this resource provides (`PUT /staff/:id/services`). */
  async setServices(workspaceId: string, id: string, serviceIdsIn: unknown): Promise<StaffResourceDto> {
    await this.find(workspaceId, id);
    const serviceIds = parseIds(serviceIdsIn, "serviceIds");
    await this.prisma.$transaction(async (tx) => {
      // Review M4: lock order services → resource (booking-locks.ts), then
      // re-check inside the transaction (concurrent delete → 404, archive →
      // the archived key, never a 500).
      await this.lockAndAssertServices(tx, workspaceId, serviceIds);
      await lockResource(tx, id);
      if (!(await tx.staffResource.findFirst({ where: { id, workspaceId }, select: { id: true } }))) {
        throw bookingError("bookings.resource_not_found");
      }
      await tx.staffService.deleteMany({ where: { resourceId: id, workspaceId } });
      if (serviceIds.length) {
        await tx.staffService.createMany({
          data: serviceIds.map((serviceId) => ({ resourceId: id, serviceId, workspaceId })),
          skipDuplicates: true,
        });
      }
    });
    return this.get(workspaceId, id);
  }

  /**
   * `bookingCount` (any status) is FK references only: it alone decides
   * archive vs delete. `upcomingCount` is for display and also counts the
   * member's upcoming legacy bookings (staffId only, no resource), which block
   * this resource's slots (rulings 2 and 4; review M2).
   */
  async deletePreview(workspaceId: string, id: string): Promise<{ bookingCount: number; upcomingCount: number; serviceCount: number }> {
    const row = await this.find(workspaceId, id);
    const [bookingCount, upcomingCount, serviceCount] = await Promise.all([
      this.prisma.appointment.count({ where: { workspaceId, resourceId: id } }),
      this.prisma.appointment.count({
        where: {
          workspaceId,
          status: { in: [...BLOCKING_STATUSES] },
          startAt: { gte: new Date() },
          OR: [{ resourceId: id }, ...(row.userId ? [{ resourceId: null, staffId: row.userId }] : [])],
        },
      }),
      this.prisma.staffService.count({ where: { workspaceId, resourceId: id } }),
    ]);
    return { bookingCount, upcomingCount, serviceCount };
  }

  /**
   * Any booking on the resource (any status) → archive (inactive, archivedAt
   * set, service links and member link kept). None → hard delete (links
   * cascade). Runs under the resource's advisory lock (`booking-resource:<id>`),
   * the one every booking writer takes, so a concurrent booking is either
   * counted here or refused there.
   */
  async remove(workspaceId: string, id: string): Promise<{ deleted: true } | { archived: true; bookingCount: number }> {
    await this.find(workspaceId, id);
    return this.prisma.$transaction(async (tx) => {
      await lockResource(tx, id);
      const row = await tx.staffResource.findFirst({ where: { id, workspaceId } });
      if (!row) throw bookingError("bookings.resource_not_found");
      const bookingCount = await tx.appointment.count({ where: { workspaceId, resourceId: id } });
      if (bookingCount > 0) {
        await tx.staffResource.updateMany({
          where: { id, workspaceId },
          data: { active: false, archivedAt: row.archivedAt ?? new Date(), version: { increment: 1 } },
        });
        return { archived: true as const, bookingCount };
      }
      await tx.staffResource.deleteMany({ where: { id, workspaceId } });
      return { deleted: true as const };
    });
  }

  async restore(workspaceId: string, id: string): Promise<StaffResourceDto> {
    await this.find(workspaceId, id);
    await this.prisma.staffResource.updateMany({
      where: { id, workspaceId },
      data: { active: true, archivedAt: null, version: { increment: 1 } },
    });
    return this.get(workspaceId, id);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async find(workspaceId: string, id: string): Promise<StaffResource> {
    const row = await this.prisma.staffResource.findFirst({ where: { id, workspaceId } });
    if (!row) throw bookingError("bookings.resource_not_found");
    return row;
  }

  private async conflict(workspaceId: string, row: StaffResource) {
    const [current] = await this.toDtos(workspaceId, [row]);
    return bookingError("bookings.version_conflict", { current });
  }

  /**
   * `userId` must be a member of this workspace (400 `bookings.not_a_member`)
   * without another resource (409 `bookings.member_has_resource {resourceId}`,
   * archived ones included, so the UI can offer a restore). null/"" unlinks.
   */
  private async memberOrNull(workspaceId: string, userId: unknown, selfId: string | null): Promise<string | null> {
    if (userId === null || userId === undefined || userId === "") return null;
    if (typeof userId !== "string") throw new BadRequestException("userId must be a string");
    const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } });
    if (!member) throw bookingError("bookings.not_a_member");
    const other = await this.prisma.staffResource.findFirst({
      where: { workspaceId, userId, ...(selfId ? { id: { not: selfId } } : {}) },
      select: { id: true },
    });
    if (other) throw bookingError("bookings.member_has_resource", { resourceId: other.id });
    return userId;
  }

  /** A concurrent link of the same member loses on the unique index → the same 409. */
  private async uniqueMember<T>(workspaceId: string, userId: string | null, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (userId && (e as { code?: string })?.code === "P2002") {
        const other = await this.prisma.staffResource.findFirst({ where: { workspaceId, userId }, select: { id: true } });
        throw bookingError("bookings.member_has_resource", { resourceId: other?.id ?? null });
      }
      throw e;
    }
  }

  /** Locks each service (sorted), then: every id must be a non-archived service of this workspace. */
  private async lockAndAssertServices(tx: Pick<PrismaService, "service" | "$executeRaw">, workspaceId: string, ids: string[]) {
    if (!ids.length) return;
    for (const sid of [...ids].sort()) await lockService(tx, sid);
    const found = await tx.service.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true, archivedAt: true },
    });
    if (found.length !== ids.length) throw bookingError("bookings.service_not_found");
    if (found.some((s) => s.archivedAt)) throw bookingError("bookings.service_archived");
  }

  private async toDtos(workspaceId: string, rows: StaffResource[]): Promise<StaffResourceDto[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
    const [links, upcoming, legacy, users] = await Promise.all([
      this.prisma.staffService.findMany({
        where: { workspaceId, resourceId: { in: ids } },
        select: { serviceId: true, resourceId: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.appointment.groupBy({
        by: ["resourceId"],
        where: {
          workspaceId,
          resourceId: { in: ids },
          status: { in: [...BLOCKING_STATUSES] },
          startAt: { gte: new Date() },
        },
        _count: { _all: true },
      }),
      // Review M2 (display only): the members' upcoming legacy bookings.
      userIds.length
        ? this.prisma.appointment.groupBy({
            by: ["staffId"],
            where: {
              workspaceId,
              resourceId: null,
              staffId: { in: userIds },
              status: { in: [...BLOCKING_STATUSES] },
              startAt: { gte: new Date() },
            },
            _count: { _all: true },
          })
        : Promise.resolve([] as { staffId: string | null; _count: { _all: number } }[]),
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : Promise.resolve([] as { id: string; name: string }[]),
    ]);
    const counts = new Map(upcoming.map((g) => [g.resourceId, g._count._all]));
    const legacyCounts = new Map(legacy.map((g) => [g.staffId, g._count._all]));
    const byUser = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => {
      const schedule = readSchedule(r.schedule);
      const user = r.userId ? byUser.get(r.userId) : undefined;
      return {
        id: r.id,
        userId: r.userId,
        user: user ? { id: user.id, name: user.name } : null,
        name: r.name,
        nameAr: r.nameAr,
        role: r.role,
        color: r.color,
        schedule,
        scheduleConfigured: isConfigured(schedule),
        active: r.active,
        archivedAt: r.archivedAt,
        version: r.version,
        serviceIds: links.filter((l) => l.resourceId === r.id).map((l) => l.serviceId),
        upcomingCount: (counts.get(r.id) ?? 0) + (r.userId ? legacyCounts.get(r.userId) ?? 0 : 0),
      };
    });
  }
}
