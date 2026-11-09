import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { Channel } from "@prisma/client";
import { ZernioBudget } from "../../campaigns/sending/zernio-budget";
import { ZernioClient } from "../../integrations/zernio.client";
import { PrismaService } from "../../prisma/prisma.service";
import { credentialsFor } from "../channel-credentials";
import { toChannelDto, type ChannelDto } from "../channel-dto";
import { channelError } from "../channel-errors";
import { MetaGraphClient } from "../whatsapp/meta-graph.client";
import { evaluateAlerts, type AlertChange } from "./health-alerts";
import { healthCooldownMs, healthWsPerMin } from "./health-config";
import {
  asChannelHealth,
  mergeHealth,
  SIGNAL_NAMES,
  type ChannelHealth,
  type HealthTrigger,
  type RawHealthRead,
} from "./health-model";
import { readMetaHealth } from "./meta-health.reader";
import { readZernioHealth } from "./zernio-health.reader";

/** Injection token for the Zernio budget (specs pass one with a virtual clock). */
export const HEALTH_BUDGET = Symbol("HEALTH_BUDGET");

export const HEALTH_PROVIDERS = new Set(["zernio", "meta"]);

/**
 * Per-workspace live-check cap (`HEALTH_CHECK_WS_PER_MIN`, default 10 per
 * rolling minute). In memory, per machine, like SP-19's limits
 * (`min_machines_running = 1`).
 */
export class HealthCheckLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(readonly perMinute: number = healthWsPerMin()) {}

  take(ws: string, nowMs: number): { ok: true } | { ok: false; retryAfter: number } {
    const recent = (this.hits.get(ws) ?? []).filter((t) => t > nowMs - 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(ws, recent);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0] + 60_000 - nowMs) / 1000)) };
    }
    recent.push(nowMs);
    this.hits.set(ws, recent);
    return { ok: true };
  }

  /** Give back a slot whose check never ran (it lost the per-number claim). */
  refund(ws: string, nowMs: number): void {
    const list = this.hits.get(ws);
    const i = list?.lastIndexOf(nowMs) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
  }
}

/** What the optional downgrade hook receives (Task 2 binds notifications). */
export interface HealthDowngrade {
  channel: Channel;
  health: ChannelHealth;
  changes: AlertChange[];
}

export interface ClaimedCheckResult {
  channel: ChannelDto;
  /** False when the claim was superseded before the write (nothing written). */
  written: boolean;
  /** The downgrades this check notified (empty unless written). */
  changes: AlertChange[];
}

/**
 * SP-14 number health. `check` is the live check (`POST
 * /channels/:id/health/check`); `claim` + `checkClaimed` are what the sweep
 * uses. Every write is raw SQL so `Channel.updatedAt` (SP-19's routing
 * tie-break) never moves (ruling R3):
 *  - claim: sets `healthAttemptedAt` only when it is null or older than the
 *    cooldown (the cooldown and the cross-machine lease in one statement);
 *  - write: sets `health` and `healthCheckedAt` only while `healthAttemptedAt`
 *    still equals this check's claim token (fencing).
 */
@Injectable()
export class ChannelHealthService {
  private readonly log = new Logger(ChannelHealthService.name);
  readonly wsLimiter = new HealthCheckLimiter();
  private readonly budget: ZernioBudget;
  /** Called after a won write that found downgrades (at most once per downgrade). */
  onDowngrade?: (e: HealthDowngrade) => Promise<void> | void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    private readonly graph: MetaGraphClient,
    @Optional() @Inject(HEALTH_BUDGET) budget?: ZernioBudget,
  ) {
    this.budget = budget ?? ZernioBudget.shared();
  }

  get cooldownMs(): number {
    return healthCooldownMs();
  }

  /** The live check. Answers the channel DTO with its new health. */
  async check(workspaceId: string, id: string, opts: { trigger?: HealthTrigger; now?: Date } = {}): Promise<ChannelDto> {
    const now = opts.now ?? new Date();
    const row = await this.prisma.channel.findFirst({ where: { id, workspaceId } });
    if (!row) throw channelError("channels.not_found");
    assertCheckable(row);

    const slot = this.wsLimiter.take(workspaceId, now.getTime());
    if (!slot.ok) throw channelError("channels.health_check_busy", { retryAfter: slot.retryAfter });

    const token = await this.claim(row.id, workspaceId, now, this.cooldownMs);
    if (!token) {
      this.wsLimiter.refund(workspaceId, now.getTime());
      const cur = await this.prisma.channel.findFirst({
        where: { id: row.id, workspaceId },
        select: { healthAttemptedAt: true },
      });
      const attempted = cur?.healthAttemptedAt instanceof Date ? cur.healthAttemptedAt.getTime() : now.getTime();
      const nextAt = new Date(Math.max(attempted + this.cooldownMs, now.getTime() + 1000));
      throw channelError("channels.health_check_cooldown", {
        retryAfter: Math.max(1, Math.ceil((nextAt.getTime() - now.getTime()) / 1000)),
        nextAt: nextAt.toISOString(),
      });
    }
    return (await this.checkClaimed(row, token, opts.trigger ?? "manual", now)).channel;
  }

  /**
   * Claim the number for a check: sets `healthAttemptedAt = now` when it is
   * null or at least `minAgeMs` old. Returns the claim token (`now`), or null
   * when another check holds it (cooldown or a concurrent check).
   */
  async claim(id: string, workspaceId: string, now: Date, minAgeMs: number): Promise<Date | null> {
    const at = now.toISOString();
    const cutoff = new Date(now.getTime() - minAgeMs).toISOString();
    // ISO strings cast to timestamp(3) keep the UTC wall clock, as Prisma stores DateTime.
    const n = await this.prisma.$executeRaw`UPDATE "Channel" SET "healthAttemptedAt" = ${at}::timestamp(3) WHERE "id" = ${id} AND "workspaceId" = ${workspaceId} AND ("healthAttemptedAt" IS NULL OR "healthAttemptedAt" <= ${cutoff}::timestamp(3))`;
    return Number(n) === 1 ? new Date(now.getTime()) : null;
  }

  /** Fenced write: only while `healthAttemptedAt` still equals `token`. */
  async write(id: string, token: Date, health: ChannelHealth, now: Date): Promise<boolean> {
    const json = JSON.stringify(health);
    const at = now.toISOString();
    const tok = token.toISOString();
    const n = await this.prisma.$executeRaw`UPDATE "Channel" SET "health" = ${json}::jsonb, "healthCheckedAt" = ${at}::timestamp(3) WHERE "id" = ${id} AND "healthAttemptedAt" = ${tok}::timestamp(3)`;
    return Number(n) === 1;
  }

  /**
   * Read, merge and write a number this caller has claimed (`token`). The
   * previous health is re-read after the claim, so it is the latest one any
   * fenced writer stored. Never throws for a provider failure: failing
   * fields become unknown with their error key.
   */
  async checkClaimed(
    row: Pick<Channel, "id" | "workspaceId">,
    token: Date,
    trigger: HealthTrigger,
    now: Date = token,
  ): Promise<ClaimedCheckResult> {
    const fresh = await this.prisma.channel.findFirst({ where: { id: row.id, workspaceId: row.workspaceId } });
    if (!fresh) throw channelError("channels.not_found");
    const previous = asChannelHealth(fresh.health);
    const read = await this.read(fresh);
    const health = mergeHealth(previous, read, { now, trigger });
    const { changes, alerts } = evaluateAlerts(previous?.alerts ?? null, health, now);
    health.alerts = alerts;

    const written = await this.write(fresh.id, token, health, now);
    if (!written) this.log.log(`health check of channel ${fresh.id} was superseded; nothing written`);
    if (written && changes.length && this.onDowngrade) {
      try {
        await this.onDowngrade({ channel: fresh, health, changes });
      } catch (e) {
        // At most once (ruling 8): the write stands; a lost alert is logged.
        this.log.warn(`downgrade hook failed for channel ${fresh.id}: ${(e as Error)?.name ?? "error"}`);
      }
    }
    const after = await this.prisma.channel.findFirst({ where: { id: fresh.id, workspaceId: fresh.workspaceId } });
    return { channel: toChannelDto(after ?? fresh, {}, now), written, changes: written ? changes : [] };
  }

  /** One provider read for the channel. Never throws. */
  private async read(row: Channel): Promise<RawHealthRead> {
    const provider = row.provider === "meta" ? "meta" : "zernio";
    try {
      const creds = await credentialsFor(this.prisma, row);
      const effective = creds.provider === "meta" || creds.provider === "zernio" ? creds.provider : provider;
      if (effective === "zernio") return await readZernioHealth(this.zernio, this.budget, creds.externalId);
      return await readMetaHealth(this.graph, creds, await this.wabaIdOf(row));
    } catch (e) {
      this.log.warn(`health read failed for channel ${row.id}: ${(e as Error)?.name ?? "error"}`);
      const fields: RawHealthRead["fields"] = {};
      for (const f of SIGNAL_NAMES) fields[f] = { error: "check_failed" };
      return { provider, fields, templates: { error: "check_failed" } };
    }
  }

  /** `Channel.config.wabaId`, else `Integration.raw.wabaId` for a legacy-linked number. */
  private async wabaIdOf(row: Channel): Promise<string | null> {
    const cfg = row.config as Record<string, unknown> | null;
    if (cfg && typeof cfg === "object" && typeof cfg.wabaId === "string" && cfg.wabaId) return cfg.wabaId;
    if (!row.integrationId) return null;
    const integ = await this.prisma.integration.findFirst({ where: { id: row.integrationId }, select: { raw: true } });
    if (!integ?.raw) return null;
    try {
      const raw = JSON.parse(integ.raw) as { wabaId?: unknown };
      return typeof raw?.wabaId === "string" && raw.wabaId ? raw.wabaId : null;
    } catch {
      return null;
    }
  }
}

/** Only connected Zernio / Meta WhatsApp numbers have a health. */
export function assertCheckable(row: Pick<Channel, "id" | "kind" | "provider" | "status">): void {
  if (row.kind !== "whatsapp" || !HEALTH_PROVIDERS.has(row.provider)) {
    throw channelError("channels.health_unsupported", { provider: row.provider });
  }
  if (row.status === "disconnected") throw channelError("channels.disconnected", { channelId: row.id });
}
