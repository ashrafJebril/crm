import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { billingError } from "./billing-errors";
import { USAGE_MAX_RANGE_DAYS } from "./billing-constants";
import { METERS, PLANS, planKeyOf, type Meter } from "./plan-catalog";

const DAY_MS = 86_400_000;

export interface UsageInput {
  meter: Meter;
  qty?: number;
  sourceKind: string;
  sourceId: string;
  at?: Date;
}

/** The idempotency key of one metered source. */
export const usageKey = (meter: Meter, sourceKind: string, sourceId: string) => `${meter}:${sourceKind}:${sourceId}`;

/** A local day (YYYY-MM-DD) in a timezone; the workspace timezone buckets usage. */
export function localDay(at: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * SP-28 usage metering (R6: meter everything, charge nothing in v1). One
 * `UsageEvent` per source, idempotent on `meter:sourceKind:sourceId`.
 * Callers record AFTER their own write committed, and recording NEVER throws:
 * metering is off the critical path, so a failure is logged and the send
 * (AI reply, campaign message, ads turn) goes on.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Records one source once. Returns true when this call recorded it. */
  async record(workspaceId: string, input: UsageInput): Promise<boolean> {
    try {
      const qty = Math.max(1, Math.floor(input.qty ?? 1));
      await this.prisma.usageEvent.create({
        data: {
          workspaceId,
          meter: input.meter,
          qty,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          idempotencyKey: usageKey(input.meter, input.sourceKind, input.sourceId),
          ...(input.at ? { at: input.at } : {}),
        },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") {
        this.logger.warn(`usage ${input.meter} not recorded for workspace ${workspaceId}: ${(e as Error)?.message ?? e}`);
      }
      return false;
    }
  }

  /** Records many sources of one meter at once (campaign messages). Never throws. */
  async recordMany(workspaceId: string, meter: Meter, sourceKind: string, sourceIds: string[]): Promise<number> {
    if (sourceIds.length === 0) return 0;
    try {
      const res = await this.prisma.usageEvent.createMany({
        data: [...new Set(sourceIds)].map((sourceId) => ({
          workspaceId,
          meter,
          qty: 1,
          sourceKind,
          sourceId,
          idempotencyKey: usageKey(meter, sourceKind, sourceId),
        })),
        skipDuplicates: true,
      });
      return res.count;
    } catch (e) {
      this.logger.warn(`usage ${meter} (${sourceIds.length}) not recorded for workspace ${workspaceId}: ${(e as Error)?.message ?? e}`);
      return 0;
    }
  }

  private range(from: Date, to: Date) {
    if (!(from instanceof Date) || !(to instanceof Date) || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      throw billingError("billing.invalid_range", { maxDays: USAGE_MAX_RANGE_DAYS });
    }
    if (to.getTime() - from.getTime() > USAGE_MAX_RANGE_DAYS * DAY_MS) {
      throw billingError("billing.invalid_range", { maxDays: USAGE_MAX_RANGE_DAYS });
    }
  }

  /** Totals per meter in [from, to) against the plan's allowances (null = not set, R3). */
  async summary(workspaceId: string, from: Date, to: Date, plan: string | null | undefined) {
    this.range(from, to);
    const rows = (await this.prisma.usageEvent.groupBy({
      by: ["meter"],
      where: { workspaceId, at: { gte: from, lt: to } },
      _sum: { qty: true },
    })) as Array<{ meter: string; _sum: { qty: number | null } }>;
    const key = planKeyOf(plan);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      meters: METERS.map((meter) => ({
        meter,
        used: rows.find((r) => r.meter === meter)?._sum.qty ?? 0,
        allowance: key ? PLANS[key].allowances[meter] : null,
      })),
    };
  }

  /** The workspace's timezone (Workspace.timezone, default Asia/Riyadh). */
  async timezoneOf(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId }, select: { timezone: true } });
    return ws?.timezone || "Asia/Riyadh";
  }

  /** Daily totals of one meter, bucketed by the workspace's local day. */
  async daily(workspaceId: string, meter: string, from: Date, to: Date, tz: string) {
    if (!(METERS as readonly string[]).includes(meter)) throw billingError("billing.invalid_meter", { meters: [...METERS] });
    this.range(from, to);
    const rows = (await this.prisma.usageEvent.findMany({
      where: { workspaceId, meter, at: { gte: from, lt: to } },
      select: { at: true, qty: true },
    })) as Array<{ at: Date; qty: number }>;
    const byDay = new Map<string, number>();
    for (const r of rows) {
      const d = localDay(r.at, tz);
      byDay.set(d, (byDay.get(d) ?? 0) + (r.qty ?? 1));
    }
    return {
      meter,
      tz,
      days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, qty]) => ({ day, qty })),
    };
  }
}
