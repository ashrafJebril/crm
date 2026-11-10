import { Injectable, Logger, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { workspaceContext } from "../../common/workspace-context";
import type { ZernioWhatsAppTemplate } from "../../integrations/zernio.client";
import { PrismaService } from "../../prisma/prisma.service";
import { TemplatesService } from "../../templates/templates.service";
import { CONNECTED_CHANNEL_STATUSES, defaultZernioWhatsappAccountId } from "../default-channel";
import { ChannelHealthService, HEALTH_PROVIDERS } from "./channel-health.service";
import { healthSweepBatch, healthSweepIntervalMs, healthSweepMaxMs } from "./health-config";

export interface SweepResult {
  /** Numbers this tick claimed and checked. */
  checked: number;
  /** Due numbers whose claim was lost (another tick or machine, or a live check). */
  skipped: number;
  /** Numbers whose check threw (logged; the tick went on). */
  failed: number;
}

type DueRow = { id: string; workspaceId: string; provider: string; externalId: string | null };

/**
 * Final review M1: the connected statuses plus `error`. An `error` number
 * (e.g. Meta's webhook subscription failed) is still listed in the campaign
 * sender picker and can usually still be read, so it is swept like the
 * others. When its read fails, its values become Unknown with the old ones
 * kept only as Previous — never shown stale as current.
 */
const SWEPT_STATUSES: string[] = [...CONNECTED_CHANNEL_STATUSES, "error"];

/**
 * SP-14 daily sweep (ruling 7): every hour, up to `HEALTH_SWEEP_BATCH` (50)
 * connected (or `error`, see SWEPT_STATUSES) Zernio / Meta WhatsApp numbers
 * whose last attempt is older than
 * `HEALTH_SWEEP_INTERVAL_MS` (24 h), oldest first (never-checked first), one
 * at a time, starting no check after `HEALTH_SWEEP_MAX_MS` (10 min). So each
 * number is checked about once a day and the load is spread.
 *
 * - Re-entrancy: an in-process `running` flag, plus the per-number claim
 *   (`ChannelHealthService.claim`), so overlapping ticks or two machines
 *   check a number once.
 * - Idempotent: a claimed number is no longer due, so a second tick right
 *   after checks the next numbers, and then nothing.
 * - Each number is claimed with its own `now` (the tick's start plus the
 *   time spent so far), so its `checkedAt` is when it was really checked.
 * - For the workspace's default Zernio number, the templates list the check
 *   just read reconciles the workspace's Template rows (no extra call).
 * - One number's failure is logged and does not stop the tick.
 */
@Injectable()
export class ChannelHealthScheduler {
  private readonly log = new Logger(ChannelHealthScheduler.name);
  private running = false;
  /** Elapsed-time source (specs replace it). */
  clock: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: ChannelHealthService,
    @Optional() private readonly templates?: TemplatesService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const res: SweepResult = { checked: 0, skipped: 0, failed: 0 };
    if (this.running) return res;
    this.running = true;
    try {
      const started = this.clock();
      const interval = healthSweepIntervalMs();
      const maxMs = healthSweepMaxMs();
      const cutoff = new Date(now.getTime() - interval);
      const due = (await this.prisma.channel.findMany({
        where: {
          kind: "whatsapp",
          provider: { in: [...HEALTH_PROVIDERS] },
          status: { in: SWEPT_STATUSES },
          OR: [{ healthAttemptedAt: null }, { healthAttemptedAt: { lte: cutoff } }],
        },
        orderBy: [{ healthAttemptedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
        select: { id: true, workspaceId: true, provider: true, externalId: true },
        take: healthSweepBatch(),
      })) as DueRow[];

      const defaults = new Map<string, Promise<string | null>>();
      const defaultAccount = (ws: string) => {
        if (!defaults.has(ws)) defaults.set(ws, defaultZernioWhatsappAccountId(this.prisma, ws).catch(() => null));
        return defaults.get(ws) as Promise<string | null>;
      };

      for (const row of due) {
        const elapsed = this.clock() - started;
        if (elapsed >= maxMs) break;
        const rowNow = new Date(now.getTime() + elapsed);
        try {
          await workspaceContext.run({ workspaceId: row.workspaceId, userId: "" }, async () => {
            const token = await this.health.claim(row.id, row.workspaceId, rowNow, interval);
            if (!token) {
              res.skipped++;
              return;
            }
            const isDefault = row.provider === "zernio" && !!row.externalId && (await defaultAccount(row.workspaceId)) === row.externalId;
            let list: ZernioWhatsAppTemplate[] | null = null;
            const out = await this.health.checkClaimed(
              row,
              token,
              "sweep",
              rowNow,
              isDefault ? { onZernioTemplates: (l) => (list = l) } : {},
            );
            res.checked++;
            if (list && out.written && this.templates) {
              try {
                await this.templates.reconcileFromList(row.workspaceId, list);
              } catch (e) {
                this.log.warn(`template reconcile from the sweep failed ws=${row.workspaceId}: ${(e as Error)?.name ?? "error"}`);
              }
            }
          });
        } catch (e) {
          res.failed++;
          this.log.warn(`health sweep of channel ${row.id} failed: ${(e as Error)?.message ?? "error"}`);
        }
      }
    } catch (e) {
      this.log.warn(`health sweep failed: ${(e as Error)?.message ?? "error"}`);
    } finally {
      this.running = false;
    }
    if (res.checked || res.failed) this.log.log(`health sweep: ${JSON.stringify(res)}`);
    return res;
  }
}
