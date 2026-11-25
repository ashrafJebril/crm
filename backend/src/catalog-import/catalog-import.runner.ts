import { Injectable, Logger } from "@nestjs/common";
import type { CatalogImport, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { workspaceContext } from "../common/workspace-context";
import { lockService } from "../bookings/booking-locks";
import { normalizeName } from "../bookings/names";
import {
  validateServiceData,
  validateStaffData,
  type Proposal,
  type ProposalItem,
  type ServiceItemData,
  type StaffItemData,
} from "./extraction-schema";

export const RUN_BATCH = 20;

/** Strictly increasing heartbeat so every lease value is unique (SP-03 pattern). */
function nextBeat(prev: Date | null): Date {
  return new Date(Math.max(Date.now(), (prev?.getTime() ?? 0) + 1));
}

class LeaseLost extends Error {}

export interface RunError {
  key: string;
  name: string;
  reason: string;
  /** For `service_not_found`: the names that matched no service. */
  missing?: string[];
}

interface Lease {
  beat: Date | null;
  errors: RunError[];
}

// The interactive-transaction client of the tenancy-extended PrismaService.
type Tx = Pick<PrismaService, "catalogImport" | "service" | "staffResource" | "staffService" | "$executeRaw">;

/**
 * Runs a catalog import (SP-03 runner pattern, its own table — ruling 1).
 *
 * Exactly-once: item `i` (in order, services before staff) is created in ONE
 * transaction together with a compare-and-set of the job row on
 * `{status: running, heartbeatAt: <lease>, processed: i}` that writes
 * `processed: i + 1`, the counters and a fresh heartbeat. A crash before
 * commit creates nothing; a resume starts at `processed`, so an item is never
 * created twice. A runner whose lease was taken by the resume scheduler
 * matches nothing and stops.
 *
 * Staff items link the services named in them (same run or already in the
 * catalog, by normalized name); a name with no service is a row error, not a
 * failure. Batches of RUN_BATCH yield the event loop in between.
 */
@Injectable()
export class CatalogImportRunner {
  private readonly log = new Logger(CatalogImportRunner.name);
  private readonly inFlight = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Start (or resume) a run in the background; never throws. */
  kick(jobId: string): void {
    setImmediate(() => {
      void this.run(jobId).catch(() => this.log.warn(`catalog import ${jobId}: run crashed`));
    });
  }

  isRunning(jobId: string): boolean {
    return this.inFlight.has(jobId);
  }

  /** Overridable yield point between batches. */
  protected yieldTick(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  /** Test seam: runs after each committed item (a crash here is "between transactions"). */
  protected async afterItem(_index: number): Promise<void> {}

  async run(jobId: string): Promise<void> {
    if (this.inFlight.has(jobId)) return;
    this.inFlight.add(jobId);
    try {
      const job = await this.prisma.catalogImport.findFirst({ where: { id: jobId } });
      if (!job || job.status !== "running") return;
      await workspaceContext.run({ workspaceId: job.workspaceId, userId: job.createdById ?? undefined } as never, () =>
        this.execute(job),
      );
    } catch (e) {
      if (e instanceof LeaseLost) return; // another instance owns it now
      // Anything else leaves the job running; the resume scheduler picks it up
      // once the heartbeat is stale. Only the job id is logged.
      this.log.warn(`catalog import ${jobId}: run interrupted (${(e as Error)?.name ?? "error"})`);
    } finally {
      this.inFlight.delete(jobId);
    }
  }

  private async execute(job: CatalogImport): Promise<void> {
    const proposal = (job.proposal ?? { items: [] }) as unknown as Proposal;
    const items = orderForRun(proposal.items ?? []);
    const lease: Lease = { beat: job.heartbeatAt, errors: Array.isArray(job.errors) ? ([...job.errors] as unknown as RunError[]) : [] };
    for (let i = job.processed; i < items.length; i++) {
      await this.processItem(job, items[i], i, lease);
      await this.afterItem(i);
      if ((i + 1) % RUN_BATCH === 0) await this.yieldTick();
    }
    const done = await this.prisma.catalogImport.updateMany({
      where: { id: job.id, status: "running", heartbeatAt: lease.beat, processed: items.length },
      data: { status: "done", finishedAt: new Date(), inputText: null, heartbeatAt: null },
    });
    if (done.count !== 1) throw new LeaseLost();
  }

  private async processItem(job: CatalogImport, item: ProposalItem, index: number, lease: Lease): Promise<void> {
    const beat = nextBeat(lease.beat);
    const invalid = item.kind === "service" ? validateServiceData(item.data as ServiceItemData) : validateStaffData(item.data as StaffItemData);
    const errors = [...lease.errors];
    if (invalid) errors.push({ key: item.key, name: item.data.name, reason: `${invalid.field}_invalid` });

    const write = async (tx: Tx, failed: boolean) => {
      // Exactly-once fence: our lease and this item's position.
      const claimed = await tx.catalogImport.updateMany({
        where: { id: job.id, status: "running", heartbeatAt: lease.beat, processed: index },
        data: {
          processed: index + 1,
          ...(failed ? { failed: { increment: 1 } } : { created: { increment: 1 } }),
          heartbeatAt: beat,
          errors: errors as unknown as Prisma.InputJsonValue,
        },
      });
      if (claimed.count !== 1) throw new LeaseLost();
    };

    try {
      await this.prisma.$transaction(async (tx) => {
        if (invalid) return write(tx, true);
        // Cheap early check of our lease (the CAS at the end is the real fence).
        const mine = await tx.catalogImport.findFirst({
          where: { id: job.id, status: "running", heartbeatAt: lease.beat, processed: index },
          select: { id: true },
        });
        if (!mine) throw new LeaseLost();
        if (item.kind === "service") {
          await this.createService(tx, job.workspaceId, item.data as ServiceItemData);
        } else {
          const d = item.data as StaffItemData;
          const { ids, missing } = await this.resolveServices(tx, job.workspaceId, d.services);
          if (missing.length) errors.push({ key: item.key, name: d.name, reason: "service_not_found", missing });
          await this.createStaff(tx, job.workspaceId, d, ids);
        }
        // The create and the fenced progress write commit together, or neither does.
        await write(tx, false);
      });
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      // The write failed (e.g. a linked service deleted meanwhile): record the
      // item as failed in its own fenced transaction and carry on.
      const failedErrors = [...lease.errors, { key: item.key, name: item.data.name, reason: "write_failed" }];
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.catalogImport.updateMany({
          where: { id: job.id, status: "running", heartbeatAt: lease.beat, processed: index },
          data: { processed: index + 1, failed: { increment: 1 }, heartbeatAt: beat, errors: failedErrors as unknown as Prisma.InputJsonValue },
        });
        if (claimed.count !== 1) throw new LeaseLost();
      });
      lease.beat = beat;
      lease.errors = failedErrors;
      return;
    }
    lease.beat = beat;
    lease.errors = errors;
  }

  private async createService(tx: Tx, workspaceId: string, d: ServiceItemData) {
    const order = await tx.service.count({ where: { workspaceId } });
    await tx.service.create({
      data: {
        workspaceId,
        name: d.name.trim(),
        nameAr: d.nameAr.trim(),
        durationMin: d.durationMin,
        price: d.price,
        ...(d.currency ? { currency: d.currency } : {}),
        ...(d.color ? { color: d.color } : {}),
        order,
      },
    });
  }

  /** Service names → ids (same run or already in the catalog, normalized), and the names that matched nothing. */
  private async resolveServices(tx: Tx, workspaceId: string, names: string[]) {
    const services = names.length
      ? await tx.service.findMany({
          where: { workspaceId, archivedAt: null },
          select: { id: true, name: true, nameAr: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const ids: string[] = [];
    const missing: string[] = [];
    for (const wanted of names) {
      const n = normalizeName(wanted);
      const hit = services.find((s) => normalizeName(s.name) === n || normalizeName(s.nameAr) === n);
      if (hit) {
        if (!ids.includes(hit.id)) ids.push(hit.id);
      } else missing.push(wanted);
    }
    return { ids, missing };
  }

  /** Creates the resource and links the services, under their locks (Task 1 lock order), re-checked inside. */
  private async createStaff(tx: Tx, workspaceId: string, d: StaffItemData, ids: string[]) {
    for (const id of [...ids].sort()) await lockService(tx, id);
    const live = ids.length
      ? await tx.service.findMany({ where: { workspaceId, id: { in: ids }, archivedAt: null }, select: { id: true } })
      : [];
    const created = await tx.staffResource.create({
      data: {
        workspaceId,
        name: d.name.trim(),
        nameAr: d.nameAr?.trim() || null,
        role: d.role?.trim() || null,
        schedule: d.schedule as unknown as Prisma.InputJsonValue,
      },
    });
    if (live.length) {
      await tx.staffService.createMany({
        data: live.map((s) => ({ resourceId: created.id, serviceId: s.id, workspaceId })),
        skipDuplicates: true,
      });
    }
  }
}

/** Selected items, services before staff (so staff can link services from the same run). */
export function orderForRun(items: ProposalItem[]): ProposalItem[] {
  const selected = items.filter((i) => i.selected);
  return [...selected.filter((i) => i.kind === "service"), ...selected.filter((i) => i.kind === "staff")];
}
