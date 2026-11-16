/**
 * SP-21 website crawl scheduling (R4). Every 15 minutes, website sources
 * whose `nextSyncAt` has come (not paused, not failed) are run; a refresh or
 * a new source kicks a run at once. At most CRAWL_MAX_CONCURRENT runs per
 * process and one per workspace; across processes the lease on
 * `syncStartedAt` (CrawlRunner.claim) prevents a double run.
 */
import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../prisma/prisma.service";
import { CrawlRunner, WEBSITE_STALE_MS } from "./crawl-runner";

export const CRAWL_MAX_CONCURRENT = 2;
export const CRAWL_SWEEP_BATCH = 20;

@Injectable()
export class CrawlScheduler {
  private readonly log = new Logger(CrawlScheduler.name);
  /** sourceId → workspaceId of the runs in flight in this process. */
  private readonly running = new Map<string, string>();
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: CrawlRunner,
  ) {}

  activeRuns(): number {
    return this.running.size;
  }

  /** Start a run in the background if this process has room; never throws. */
  kick(sourceId: string, workspaceId: string): boolean {
    if (!this.hasRoom(sourceId, workspaceId)) return false;
    this.running.set(sourceId, workspaceId);
    void this.runner
      .run(sourceId)
      .catch(() => this.log.warn(`website source ${sourceId}: run crashed`))
      .finally(() => this.running.delete(sourceId));
    return true;
  }

  private hasRoom(sourceId: string, workspaceId: string): boolean {
    if (this.running.has(sourceId) || this.running.size >= CRAWL_MAX_CONCURRENT) return false;
    return ![...this.running.values()].includes(workspaceId);
  }

  @Cron("0 */15 * * * *")
  async sweep(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const due = await this.prisma.knowledgeSource.findMany({
        where: {
          kind: "website",
          status: { in: ["queued", "ready"] },
          nextSyncAt: { lte: now },
          OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(now.getTime() - WEBSITE_STALE_MS) } }],
        },
        select: { id: true, workspaceId: true },
        orderBy: { nextSyncAt: "asc" },
        take: CRAWL_SWEEP_BATCH,
      });
      let started = 0;
      for (const s of due) if (this.kick(s.id, s.workspaceId)) started += 1;
      return started;
    } catch (e) {
      this.log.warn(`website sweep failed (${(e as Error)?.name ?? "error"})`);
      return 0;
    } finally {
      this.sweeping = false;
    }
  }
}
