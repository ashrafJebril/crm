import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { workspaceContext } from "../common/workspace-context";
import { PrismaService } from "../prisma/prisma.service";
import { syncBatch, syncIntervalMs, syncMaxMs } from "./meta-ads.config";
import { MetaAdsGraphClient } from "./meta-ads-graph.client";
import { MetaAdsNotifier } from "./meta-ads-notifier";
import { syncConnection } from "./meta-ads-sync";
import { readMetaAdsToken } from "./meta-ads-token";

export interface MetaAdsSweepResult {
  /** Connections this tick claimed and synced (any outcome but a lost claim). */
  synced: number;
  /** Due connections whose claim was lost (another tick or machine). */
  skipped: number;
  /** Connections whose sync threw (logged; the tick went on). */
  failed: number;
}

/**
 * SP-15 hourly spend sweep (Architecture → Spend sync).
 *  - Selection: `active` connections whose `syncAttemptedAt` is null or older
 *    than `META_ADS_SYNC_INTERVAL_MS` (55 min), oldest first, at most
 *    `META_ADS_SYNC_BATCH` (20), one at a time; no new connection starts after
 *    `META_ADS_SYNC_MAX_MS` (10 min).
 *  - Re-entrancy: an in-process `running` flag plus a raw-SQL claim on
 *    `syncAttemptedAt` (the SP-14 pattern), so overlapping ticks or two
 *    machines sync a connection once.
 *  - `pending`, `needs_reconnect` and `disconnected` are never selected.
 */
@Injectable()
export class MetaAdsSyncScheduler {
  private readonly log = new Logger(MetaAdsSyncScheduler.name);
  private running = false;
  /** Elapsed-time source (specs replace it). */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaAdsGraphClient,
    private readonly notifier: MetaAdsNotifier,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(now: Date = new Date()): Promise<MetaAdsSweepResult> {
    const res: MetaAdsSweepResult = { synced: 0, skipped: 0, failed: 0 };
    if (this.running) return res;
    this.running = true;
    try {
      const started = this.clock();
      const interval = syncIntervalMs();
      const maxMs = syncMaxMs();
      const cutoff = new Date(now.getTime() - interval);
      const due = await this.prisma.metaAdsConnection.findMany({
        where: { status: "active", OR: [{ syncAttemptedAt: null }, { syncAttemptedAt: { lte: cutoff } }] },
        orderBy: [{ syncAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        select: { id: true, workspaceId: true },
        take: syncBatch(),
      });
      for (const d of due) {
        const elapsed = this.clock() - started;
        if (elapsed >= maxMs) break;
        const rowNow = new Date(now.getTime() + elapsed);
        try {
          await workspaceContext.run({ workspaceId: d.workspaceId, userId: "" }, async () => {
            if (!(await this.claim(d.id, rowNow, interval))) {
              res.skipped++;
              return;
            }
            // Re-read after the claim: the row a disconnect or reconnect may have changed.
            const conn = await this.prisma.metaAdsConnection.findFirst({ where: { id: d.id, workspaceId: d.workspaceId } });
            if (!conn || conn.status !== "active") {
              res.skipped++;
              return;
            }
            res.synced++;
            const token = readMetaAdsToken(conn.tokenEnc);
            if (!token) {
              await this.notifier.park(conn, "token_refused");
              return;
            }
            // The tick's deadline also bounds each connection's own reads (M4).
            const out = await syncConnection(conn, token, rowNow, {
              prisma: this.prisma,
              graph: this.graph,
              notifier: this.notifier,
              log: this.log,
              clock: this.clock,
              deadline: started + maxMs,
            });
            if (out.result !== "ok") this.log.log(`meta ads sync ws=${d.workspaceId}: ${out.result}`);
          });
        } catch (e) {
          res.failed++;
          this.log.warn(`meta ads sync of connection ${d.id} failed: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? "error"}`);
        }
      }
    } catch (e) {
      this.log.warn(`meta ads sweep failed: ${(e as { code?: string })?.code ?? (e as Error)?.name ?? "error"}`);
    } finally {
      this.running = false;
    }
    if (res.synced || res.failed) this.log.log(`meta ads sweep: ${JSON.stringify(res)}`);
    return res;
  }

  /** Claim: sets `syncAttemptedAt` when the connection is active and due. Raw SQL, no `updatedAt` bump. */
  private async claim(id: string, now: Date, minAgeMs: number): Promise<boolean> {
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
    const n = await this.prisma.$executeRaw`UPDATE "MetaAdsConnection" SET "syncAttemptedAt" = ${at}::timestamp(3) WHERE "id" = ${id} AND "status" = 'active' AND ("syncAttemptedAt" IS NULL OR "syncAttemptedAt" <= ${cutoff}::timestamp(3))`;
    return Number(n) === 1;
  }
}
