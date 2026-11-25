import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogImportRunner } from "./catalog-import.runner";

/** A running import whose heartbeat is older than this is resumed (SP-03 value). */
export const STALE_RUN_MS = 2 * 60 * 1000;
/** An extraction older than this died with its process (the call itself times out within 270 s). */
export const STALE_EXTRACTION_MS = 5 * 60 * 1000;
/**
 * A stale run started longer ago than this is failed (`run_stalled`), not
 * resumed again: a run of at most 150 items keeps crashing (review M3).
 * CATALOG_IMPORT_RUN_MAX_MS overrides it.
 */
export const RUN_STALL_MS = 30 * 60 * 1000;

function runStallMs(): number {
  const n = Number(process.env.CATALOG_IMPORT_RUN_MAX_MS?.trim());
  return Number.isFinite(n) && n > 0 ? n : RUN_STALL_MS;
}

/**
 * Resumes catalog imports whose runner died, and fails extractions that
 * died. Re-entrancy guarded; each job is claimed by compare-and-set on the
 * heartbeat it was seen with, so two instances never both resume it. Reads
 * only `CatalogImport` (ruling 1): `main`'s ImportJob sweeps never see these.
 */
@Injectable()
export class CatalogImportResumeScheduler {
  private readonly log = new Logger(CatalogImportResumeScheduler.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CatalogImportRunner,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      await this.failStaleExtractions(now);
      return await this.resumeStaleRuns(now);
    } catch (e) {
      this.log.warn(`catalog import sweep failed (${(e as Error)?.name ?? "error"})`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }

  private async resumeStaleRuns(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_RUN_MS);
    const stallCutoff = now.getTime() - runStallMs();
    const stale = await this.prisma.catalogImport.findMany({
      where: {
        status: "running",
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }],
      },
      select: { id: true, heartbeatAt: true, startedAt: true },
      take: 20,
    });
    let resumed = 0;
    for (const j of stale) {
      if (this.runner.isRunning(j.id)) continue;
      if (j.startedAt && j.startedAt.getTime() < stallCutoff) {
        // Same compare-and-set as the claim: only the instance that saw this heartbeat fails it.
        const failed = await this.prisma.catalogImport.updateMany({
          where: { id: j.id, status: "running", heartbeatAt: j.heartbeatAt },
          data: { status: "failed", errorKey: "catalog_import.run_stalled", inputText: null, heartbeatAt: null, finishedAt: now },
        });
        if (failed.count === 1) this.log.warn(`catalog import ${j.id} stalled; failed`);
        continue;
      }
      const claim = await this.prisma.catalogImport.updateMany({
        where: { id: j.id, status: "running", heartbeatAt: j.heartbeatAt },
        data: { heartbeatAt: now },
      });
      if (claim.count !== 1) continue;
      this.log.warn(`resuming stale catalog import ${j.id}`);
      this.runner.kick(j.id);
      resumed += 1;
    }
    return resumed;
  }

  private async failStaleExtractions(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - STALE_EXTRACTION_MS);
    await this.prisma.catalogImport.updateMany({
      where: { status: "extracting", OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, createdAt: { lt: cutoff } }] },
      data: { status: "failed", errorKey: "catalog_import.ai_failed", inputText: null, heartbeatAt: null, finishedAt: now },
    });
  }
}
