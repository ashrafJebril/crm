import { Injectable } from "@nestjs/common";
import type { Appointment, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { MAX_DAYS_AHEAD } from "./booking-constants";
import { bookingError } from "./booking-errors";
import { OPEN_STATUSES, isOpenStatus } from "./booking-status";
import { daysBetween, isDateISO, isoWithOffset, localDayRange, todayISO, workspaceTz } from "./booking-time";
import { generateSlots, overlaps, type Interval } from "./availability";
import { readSchedule, scheduleFitAt } from "./schedule";
import { normalizeName } from "./names";
import { priceOut } from "./catalog-fields";

/** Minimum overlap look-back (SERVICE_DURATION_MAX); widened to the longest open booking found (review I3). */
const MIN_LOOKBACK_MS = 1440 * 60_000;
const SEARCH_LIMIT = 10;
/** Search scans this many bookings on each side of now (review M3). */
const SEARCH_SCAN_EACH_SIDE = 1000;

export type Fit = "ok" | "off_day" | "outside_hours" | "unchecked";

export interface AvailabilityDto {
  date: string;
  tz: string;
  serviceId: string;
  durationMin: number;
  slots: { startAt: string; resourceId: string }[];
  /** Resource ids with no schedule (they are not gated, but offer no slots). */
  unconfigured: string[];
  /** True only when the hard cap (MAX_SLOTS, far above a real day) cut the list (review I2). */
  truncated: boolean;
}

export interface BookingSearchItem {
  id: string;
  startAt: Date;
  status: string;
  contactId: string;
  contactName: string | null;
  service: string;
  serviceAr: string;
}

type Db = Pick<PrismaService, "appointment" | "staffResource"> | Prisma.TransactionClient;
type Keyed = Pick<Appointment, "id" | "startAt" | "durationMin" | "status" | "resourceId" | "staffId">;

/**
 * How far back an open booking can start and still reach `from`: at least
 * 24 h, or the longest open booking matching `where` (rows written by `main`
 * or before the cap may be longer than 1440 min). Review I3.
 */
export async function lookbackMs(db: Db, where: Prisma.AppointmentWhereInput): Promise<number> {
  const longest = await (db as PrismaService).appointment.findFirst({
    where: { ...where, status: { in: [...OPEN_STATUSES] } },
    orderBy: { durationMin: "desc" },
    select: { durationMin: true },
  });
  return Math.max(MIN_LOOKBACK_MS, (longest?.durationMin ?? 0) * 60_000);
}

export interface ResourceKey {
  id: string;
  userId: string | null;
}

/** Interval of a booking row. */
export function intervalOf(row: { startAt: Date; durationMin: number }): Interval {
  const start = row.startAt.getTime();
  return { start, end: start + row.durationMin * 60_000 };
}

/**
 * Open bookings that hold time on these resources in [from, to): rows placed
 * on the resource, and legacy/agent/HJZ rows with no resource whose staffId is
 * the resource's member (ruling 4). Each result names the resource it blocks.
 */
export async function blockingBookings(
  db: Db,
  workspaceId: string,
  resources: ResourceKey[],
  from: Date,
  to: Date,
  excludeId?: string,
): Promise<(Pick<Appointment, "id" | "startAt" | "durationMin" | "status" | "resourceId" | "staffId"> & { blocks: string })[]> {
  if (!resources.length) return [];
  const ids = resources.map((r) => r.id);
  const members = resources.filter((r) => r.userId).map((r) => r.userId as string);
  const keys: Prisma.AppointmentWhereInput = {
    workspaceId,
    ...(excludeId ? { id: { not: excludeId } } : {}),
    OR: [{ resourceId: { in: ids } }, ...(members.length ? [{ resourceId: null, staffId: { in: members } }] : [])],
  };
  const back = await lookbackMs(db, keys);
  const rows = await (db as PrismaService).appointment.findMany({
    where: {
      ...keys,
      status: { in: [...OPEN_STATUSES] },
      startAt: { gte: new Date(from.getTime() - back), lt: to },
    },
    select: { id: true, startAt: true, durationMin: true, status: true, resourceId: true, staffId: true },
    orderBy: { startAt: "asc" },
  });
  const byUser = new Map(resources.filter((r) => r.userId).map((r) => [r.userId as string, r.id]));
  const window = { start: from.getTime(), end: to.getTime() };
  return rows
    .filter((r) => overlaps(intervalOf(r), window))
    .map((r) => ({ ...r, blocks: r.resourceId ?? (byUser.get(r.staffId as string) as string) }));
}

/**
 * SP-10 bookings read side: availability, search, and the `conflict`/`fit`
 * annotations on appointment rows. Every query is workspace-scoped; foreign
 * ids are 404.
 */
@Injectable()
export class BookingsService {
  constructor(private readonly prisma: PrismaService) {}

  async workspaceTz(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
    return workspaceTz(ws?.timezone);
  }

  /** `GET /bookings/availability`. */
  async availability(
    workspaceId: string,
    q: { serviceId: string; resourceId?: string; date: string },
    now: Date = new Date(),
  ): Promise<AvailabilityDto> {
    const tz = await this.workspaceTz(workspaceId);
    if (!isDateISO(q.date)) throw bookingError("bookings.date_invalid");
    const ahead = daysBetween(todayISO(now, tz), q.date);
    if (ahead < 0 || ahead > MAX_DAYS_AHEAD) throw bookingError("bookings.date_invalid", { maxDaysAhead: MAX_DAYS_AHEAD });

    const service = await this.prisma.service.findFirst({ where: { id: q.serviceId, workspaceId } });
    if (!service) throw bookingError("bookings.service_not_found");
    const base: AvailabilityDto = {
      date: q.date,
      tz,
      serviceId: service.id,
      durationMin: service.durationMin,
      slots: [],
      unconfigured: [],
      truncated: false,
    };

    let resources: { id: string; userId: string | null; schedule: Prisma.JsonValue; active: boolean; archivedAt: Date | null }[];
    if (q.resourceId) {
      const r = await this.prisma.staffResource.findFirst({ where: { id: q.resourceId, workspaceId } });
      if (!r) throw bookingError("bookings.resource_not_found");
      const link = await this.prisma.staffService.findFirst({ where: { workspaceId, resourceId: r.id, serviceId: service.id } });
      if (!link) throw bookingError("bookings.resource_not_offering");
      resources = [r];
    } else {
      const links = await this.prisma.staffService.findMany({ where: { workspaceId, serviceId: service.id }, select: { resourceId: true } });
      resources = links.length
        ? await this.prisma.staffResource.findMany({
            where: { workspaceId, id: { in: links.map((l) => l.resourceId) } },
            orderBy: { createdAt: "asc" },
          })
        : [];
    }
    // Archived or paused services and resources offer nothing.
    if (!service.active || service.archivedAt) return base;
    resources = resources.filter((r) => r.active && !r.archivedAt);
    if (!resources.length) return base;

    const { start, end } = localDayRange(q.date, tz);
    const busy = await blockingBookings(this.prisma, workspaceId, resources, start, end);
    const { slots, unconfigured, truncated } = generateSlots({
      dateISO: q.date,
      tz,
      durationMin: service.durationMin,
      now,
      resources: resources.map((r) => ({
        id: r.id,
        schedule: r.schedule,
        busy: busy.filter((b) => b.blocks === r.id).map(intervalOf),
      })),
    });
    return {
      ...base,
      slots: slots.map((s) => ({ startAt: isoWithOffset(s.startAt, tz), resourceId: s.resourceId })),
      unconfigured,
      truncated,
    };
  }

  /** Active, non-archived services, for the agent's `list_services` tool. */
  async activeServices(workspaceId: string) {
    const rows = await this.prisma.service.findMany({
      where: { workspaceId, active: true, archivedAt: null },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      nameAr: s.nameAr,
      durationMin: s.durationMin,
      price: priceOut(s.price),
      currency: s.currency,
    }));
  }

  /**
   * `GET /appointments/search?q`: ≤ 10 bookings whose contact name (Arabic
   * normalized), phone digits or service name (either language) match.
   * Scans the bookings nearest the present: up to SEARCH_SCAN_EACH_SIDE
   * starting from now on and as many before now; results are ordered by
   * distance from now.
   */
  async search(workspaceId: string, qIn: string | undefined, now: Date = new Date()): Promise<{ items: BookingSearchItem[] }> {
    const q = (qIn ?? "").trim();
    if (q.length < 2) return { items: [] };
    const needle = normalizeName(q);
    const digits = q.replace(/\D/g, "");
    const include = { contact: { select: { id: true, name: true, phone: true } } } as const;
    const [ahead, behind] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { workspaceId, startAt: { gte: now } },
        orderBy: { startAt: "asc" },
        take: SEARCH_SCAN_EACH_SIDE,
        include,
      }),
      this.prisma.appointment.findMany({
        where: { workspaceId, startAt: { lt: now } },
        orderBy: { startAt: "desc" },
        take: SEARCH_SCAN_EACH_SIDE,
        include,
      }),
    ]);
    const rows = [...ahead, ...behind];
    const hit = rows.filter((r) => {
      const c = (r as unknown as { contact?: { name?: string | null; phone?: string | null } }).contact;
      if (needle && [c?.name, r.service, r.serviceAr].some((n) => normalizeName(n).includes(needle))) return true;
      return digits.length >= 2 && (c?.phone ?? "").replace(/\D/g, "").includes(digits);
    });
    const t = now.getTime();
    hit.sort((a, b) => Math.abs(a.startAt.getTime() - t) - Math.abs(b.startAt.getTime() - t));
    return {
      items: hit.slice(0, SEARCH_LIMIT).map((r) => ({
        id: r.id,
        startAt: r.startAt,
        status: r.status,
        contactId: r.contactId,
        contactName: (r as unknown as { contact?: { name?: string | null } }).contact?.name ?? null,
        service: r.service,
        serviceAr: r.serviceAr,
      })),
    };
  }

  /**
   * Adds `conflict` (another open booking of the same resource or member
   * overlaps; only for open rows) and `fit` (the resource's schedule in the
   * workspace timezone; "unchecked" without a resource) to appointment rows.
   * `complete`: the rows are every booking of the workspace (no filter), so
   * they serve as the overlap candidates without a second query.
   */
  async annotate<T extends Appointment>(
    workspaceId: string,
    rows: T[],
    opts: { complete?: boolean } = {},
  ): Promise<(T & { conflict: boolean; fit: Fit })[]> {
    if (!rows.length) return [];
    const [tz, resources] = await Promise.all([
      this.workspaceTz(workspaceId),
      this.prisma.staffResource.findMany({ where: { workspaceId }, select: { id: true, userId: true, schedule: true } }),
    ]);
    const byId = new Map(resources.map((r) => [r.id, r]));
    const byUser = new Map(resources.filter((r) => r.userId).map((r) => [r.userId as string, r]));
    const resourceOf = (a: Pick<Appointment, "resourceId" | "staffId">) =>
      a.resourceId ?? (a.staffId ? byUser.get(a.staffId)?.id ?? null : null);
    const memberOf = (a: Pick<Appointment, "resourceId" | "staffId">) =>
      a.resourceId ? byId.get(a.resourceId)?.userId ?? null : a.staffId ?? null;

    const open = rows.filter((r) => isOpenStatus(r.status));
    let candidates: Keyed[] = [];
    if (open.length) {
      if (opts.complete) {
        candidates = open;
      } else {
        const resIds = [...new Set(open.map(resourceOf).filter((x): x is string => !!x))];
        const members = [...new Set(open.map(memberOf).filter((x): x is string => !!x))];
        if (resIds.length || members.length) {
          const keys: Prisma.AppointmentWhereInput = {
            workspaceId,
            OR: [
              ...(resIds.length ? [{ resourceId: { in: resIds } }] : []),
              ...(members.length ? [{ staffId: { in: members } }] : []),
            ],
          };
          const back = await lookbackMs(this.prisma, keys);
          let min = Infinity;
          let max = -Infinity;
          for (const r of open) {
            min = Math.min(min, r.startAt.getTime());
            max = Math.max(max, intervalOf(r).end);
          }
          const found = await this.prisma.appointment.findMany({
            where: { ...keys, status: { in: [...OPEN_STATUSES] }, startAt: { gte: new Date(min - back), lt: new Date(max) } },
            select: { id: true, startAt: true, durationMin: true, status: true, resourceId: true, staffId: true },
          });
          const seen = new Set(found.map((c) => c.id));
          candidates = [...found, ...open.filter((r) => !seen.has(r.id))];
        }
      }
    }

    // Review I1: bucket the open candidates by resource and by member, sort
    // each bucket by start, and sweep, so the whole-history list is
    // O(n log n). A row conflicts when it overlaps another row of a bucket it
    // is in: in start order, that is "starts before the latest end so far"
    // or "ends after the next start".
    const conflicted = new Set<string>();
    const buckets = new Map<string, { id: string; start: number; end: number }[]>();
    const add = (key: string, c: Keyed) => {
      const list = buckets.get(key) ?? [];
      list.push({ id: c.id, ...intervalOf(c) });
      buckets.set(key, list);
    };
    for (const c of candidates) {
      const r = resourceOf(c);
      const m = memberOf(c);
      if (r) add(`r:${r}`, c);
      if (m) add(`m:${m}`, c);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.start - b.start || a.end - b.end);
      let maxEnd = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        const next = list[i + 1];
        if (cur.start < maxEnd || (next && next.start < cur.end)) conflicted.add(cur.id);
        maxEnd = Math.max(maxEnd, cur.end);
      }
    }

    return rows.map((r) => {
      let fit: Fit = "unchecked";
      const res = r.resourceId ? byId.get(r.resourceId) : undefined;
      if (res) fit = scheduleFitAt(readSchedule(res.schedule), r.startAt, r.durationMin, tz).kind;
      const conflict = isOpenStatus(r.status) && conflicted.has(r.id);
      return { ...r, conflict, fit };
    });
  }
}
