import { HttpException, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ZernioClient, ZernioRateLimitError } from "../../integrations/zernio.client";
import { MediaService } from "../../media/media.service";
import { NotificationsService } from "../../notifications/notifications.service";
import { workspaceContext } from "../../common/workspace-context";
import { RecipientTrackerService } from "../tracking/recipient-tracker.service";
import { campaignError } from "../campaign-errors";
import { AUDIENCE_PAGE } from "./audience-stream";
import { type PartitionRow, prepareBroadcastPartition, sendBroadcastPartition } from "./broadcast-transport";
import { sendDirectPartition } from "./direct-transport";
import { CancelRequested, defIdsFor, type LaunchJob, LeaseLost, loadCustomDefs, resolveLaunchSenders } from "./launch-context";
import { planLaunch } from "./launch-plan";
import { effectiveSenderIds } from "./senders";
import { type VarMap, validateVarMapShape } from "./var-map";
import { withRetryAfter, ZernioBudget } from "./zernio-budget";

/** Transient failures (DB connection, Zernio 429/5xx) retried by resumes before the job fails. */
export const MAX_LAUNCH_ATTEMPTS = 5;
/** Header links live until the send plus this margin (ruling 9) … */
export const HEADER_LINK_MARGIN_MS = 72 * 3_600_000;
/** … and at most this long (Spaces presigned URLs). */
export const HEADER_LINK_MAX_MS = 7 * 24 * 3_600_000;

const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]);
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);

/** Connection, timeout, rate-limit and upstream 5xx errors a later resume can survive. */
export function isTransientLaunchError(e: unknown): boolean {
  if (e instanceof ZernioRateLimitError) return true;
  if (e instanceof HttpException) {
    // Our own keyed errors are decisions, never transient.
    if (campaignErrorKey(e)) return false;
    return TRANSIENT_HTTP.has(e.getStatus());
  }
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && (TRANSIENT_DB_CODES.has(code) || /^(ECONNRESET|ETIMEDOUT|ECONNREFUSED)$/.test(code))) return true;
  return /can't reach database|connection (terminated|closed|reset)|timed out|timeout/i.test((e as Error)?.message ?? "");
}

/** The `campaigns.*` key of a keyed error, else null. */
export function campaignErrorKey(e: unknown): string | null {
  if (!(e instanceof HttpException)) return null;
  const body = e.getResponse() as { message?: unknown } | string;
  const msg = typeof body === "string" ? body : body?.message;
  return typeof msg === "string" && /^campaigns\.[a-z_]+$/.test(msg) ? msg : null;
}

/** Strictly increasing heartbeat so every lease value is unique (as SP-03). */
function nextBeat(prev: Date | null): Date {
  return new Date(Math.max(Date.now(), (prev?.getTime() ?? 0) + 1));
}

interface Lease {
  id: string;
  workspaceId: string;
  beat: Date | null;
  launchAttempts: number;
  launchedById: string | null;
  name: string;
  partitionId: string | null;
}

const PARTITION_ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];
const DONE_STAGES = ["sent", "scheduled", "cancelled", "failed"];

/**
 * SP-13 background launch (SP-12 R10), on the SP-03 ImportRunner pattern.
 *
 * `POST /campaigns/:id/launch` validates and claims the draft as
 * `launching`/`planning`, then `kick`s this runner. A run:
 * 1. plans (rows and partitions, no external call; restarts from scratch);
 * 2. sends: broadcast partitions are each imported, created (with draft
 *    adoption) and filled, then each sent or scheduled behind Zernio's own
 *    status check; or every recipient gets one direct send with a stable
 *    Idempotency-Key;
 * 3. finishes: `scheduled`/`running` (broadcast), `running` (direct; the
 *    scheduler completes it once no row is queued), or waits as `scheduled`
 *    (a scheduled direct campaign; the scheduler starts it when due).
 *
 * Lease fencing: every Zernio call and every write is preceded by a
 * compare-and-set of `launchHeartbeatAt` (`fence`). A runner whose lease the
 * resume scheduler took (a stale heartbeat) matches nothing and stops
 * without another call or write. `cancelRequestedAt` is checked by the same
 * compare-and-set. Every Zernio call also takes a process-wide budget token
 * (ruling R19) and waits out a 429's Retry-After.
 *
 * Transient errors leave the job `launching` for the next resume, up to
 * MAX_LAUNCH_ATTEMPTS; anything else fails it with a keyed `lastError` and
 * notifies `launchedById`.
 */
@Injectable()
export class CampaignLaunchRunner {
  private readonly log = new Logger(CampaignLaunchRunner.name);
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly tracker: RecipientTrackerService;

  /** Audience page size (tests lower it). */
  pageSize = AUDIENCE_PAGE;
  /** Contacts per `bulkCreateContacts` (Zernio's maximum). */
  importPageSize = 1000;
  /** Phones per `addBroadcastRecipients` (Zernio's maximum). */
  addPageSize = 100;
  /** Rows per direct-send page. */
  directPageSize = 100;
  /** The Zernio budget (process-wide by default). */
  budget: ZernioBudget = ZernioBudget.shared();
  /** Retry-After waits. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    @Optional() private readonly media?: MediaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() tracker?: RecipientTrackerService,
  ) {
    this.tracker = tracker ?? new RecipientTrackerService(prisma);
  }

  /** Start (or resume) a launch in the background; never throws. */
  kick(id: string): void {
    const p: Promise<void> = new Promise<void>((r) => setImmediate(r))
      .then(() => this.run(id))
      .catch((e) => this.log.error(`campaign launch ${id} crashed: ${(e as Error).message}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Resolves once every kicked run has ended (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  isRunning(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Overridable yield point (spied on in tests). */
  protected yieldTick(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  /** Ruling 9: the header link lives until the send plus 72 h, at most 7 days. */
  headerTtlSeconds(scheduledAt: Date | null): number {
    const wait = scheduledAt ? Math.max(0, scheduledAt.getTime() - Date.now()) : 0;
    return Math.floor(Math.min(wait + HEADER_LINK_MARGIN_MS, HEADER_LINK_MAX_MS) / 1000);
  }

  /**
   * `GET /campaigns/:id` launch progress: two indexed queries (rows by status
   * on (campaignId, status, id); partitions on their campaign FK index).
   */
  static async progress(
    prisma: PrismaService,
    workspaceId: string,
    c: { id: string; launchStage?: string | null; sendTransport?: string | null },
  ): Promise<{ stage: string | null; planned: number; partitionsTotal: number; partitionsDone: number; directSent: number }> {
    const [groups, parts] = await Promise.all([
      prisma.campaignRecipient.groupBy({ by: ["status"], where: { workspaceId, campaignId: c.id }, _count: { _all: true } }) as unknown as Promise<
        Array<{ status: string; _count: { _all: number } }>
      >,
      prisma.campaignBroadcast.findMany({ where: { workspaceId, campaignId: c.id }, select: { stage: true } }) as Promise<Array<{ stage: string }>>,
    ]);
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const planned = groups.reduce((t, g) => t + g._count._all, 0);
    return {
      stage: c.launchStage ?? null,
      planned,
      partitionsTotal: parts.length,
      partitionsDone: parts.filter((p) => DONE_STAGES.includes(p.stage)).length,
      directSent: c.sendTransport === "direct" ? planned - n("queued") - n("skipped") : 0,
    };
  }

  async run(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    let lease: Lease | null = null;
    try {
      const c = await this.prisma.campaign.findFirst({ where: { id } });
      if (!c || c.status !== "launching") return;
      lease = {
        id: c.id,
        workspaceId: c.workspaceId,
        beat: c.launchHeartbeatAt ?? null,
        launchAttempts: c.launchAttempts ?? 0,
        launchedById: c.launchedById ?? null,
        name: c.name,
        partitionId: null,
      };
      const l = lease;
      await workspaceContext.run({ workspaceId: c.workspaceId, userId: c.launchedById ?? "" }, async () => {
        const job = this.job(l);
        try {
          if (c.cancelRequestedAt) throw new CancelRequested();
          await this.execute(job, l);
        } catch (e) {
          if (e instanceof CancelRequested) await this.cancelLaunch(job, l);
          else throw e;
        }
      });
    } catch (e) {
      if (e instanceof LeaseLost) return;
      if (lease) await this.fail(lease, e);
      else this.log.error(`campaign launch ${id} failed before its lease: ${(e as Error).message}`);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private job(lease: Lease): LaunchJob {
    const prisma = this.prisma;
    const fence = async (opts: { allowCancel?: boolean } = {}) => {
      const next = nextBeat(lease.beat);
      const res = await prisma.campaign.updateMany({
        where: { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat, ...(opts.allowCancel ? {} : { cancelRequestedAt: null }) },
        data: { launchHeartbeatAt: next },
      });
      if (res.count === 1) {
        lease.beat = next;
        return;
      }
      if (!opts.allowCancel) {
        const cur = await prisma.campaign.findFirst({
          where: { id: lease.id },
          select: { status: true, launchHeartbeatAt: true, cancelRequestedAt: true },
        });
        if (cur?.status === "launching" && cur.cancelRequestedAt && (cur.launchHeartbeatAt?.getTime() ?? null) === (lease.beat?.getTime() ?? null)) {
          throw new CancelRequested();
        }
      }
      throw new LeaseLost();
    };
    return {
      prisma,
      zernio: this.zernio,
      campaignId: lease.id,
      workspaceId: lease.workspaceId,
      fence,
      call: (fn, opts = {}) =>
        withRetryAfter(fn, {
          sleep: (ms) => this.sleep(ms),
          before: async () => {
            await this.budget.campaign.take();
            if (opts.direct) await this.budget.direct.take();
            await fence({ allowCancel: opts.allowCancel });
          },
        }),
      updatePartition: async (pid, data, opts = {}) => {
        await fence(opts);
        await prisma.campaignBroadcast.update({ where: { id: pid }, data });
      },
      setPartition: (pid) => (lease.partitionId = pid),
      yieldTick: () => this.yieldTick(),
      now: () => Date.now(),
      pageSize: this.pageSize,
      importPageSize: this.importPageSize,
      addPageSize: this.addPageSize,
      directPageSize: this.directPageSize,
    };
  }

  /** A fenced write to the campaign row (the lease compare-and-set carries the data). */
  private async writeCampaign(lease: Lease, data: Record<string, unknown>, opts: { allowCancel?: boolean } = {}): Promise<void> {
    const next = nextBeat(lease.beat);
    const res = await this.prisma.campaign.updateMany({
      where: { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat, ...(opts.allowCancel ? {} : { cancelRequestedAt: null }) },
      data: { ...data, launchHeartbeatAt: next },
    });
    if (res.count === 1) {
      lease.beat = next;
      return;
    }
    // Lost or cancelled: let fence tell which.
    await this.job(lease).fence(opts);
    throw new LeaseLost();
  }

  private partitions(lease: Lease): Promise<PartitionRow[]> {
    return this.prisma.campaignBroadcast.findMany({
      where: { workspaceId: lease.workspaceId, campaignId: lease.id },
      orderBy: PARTITION_ORDER,
    }) as unknown as Promise<PartitionRow[]>;
  }

  private async execute(job: LaunchJob, lease: Lease): Promise<void> {
    const ws = lease.workspaceId;
    const c = await this.prisma.campaign.findFirst({ where: { id: lease.id, workspaceId: ws } });
    if (!c) throw new LeaseLost();
    const workspace = await this.prisma.workspace.findUnique({ where: { id: ws }, select: { zernioProfileId: true } });
    const template = c.templateId ? await this.prisma.template.findFirst({ where: { id: c.templateId, workspaceId: ws } }) : null;
    if (!workspace?.zernioProfileId) throw campaignError("campaigns.whatsapp_not_connected");
    if (!template) throw campaignError("campaigns.template_not_approved");
    const varMap: VarMap = c.varMap ? validateVarMapShape(c.varMap) : {};
    const scheduledAt = c.scheduledAt ?? null;

    let transport = c.sendTransport as "broadcast" | "direct" | null;
    if (c.launchStage === "planning" || !c.planCompletedAt) {
      const defs = await loadCustomDefs(this.prisma, ws);
      const senders = await resolveLaunchSenders(this.prisma, ws, effectiveSenderIds(c));
      const plan = await planLaunch(job, {
        campaign: { id: c.id, workspaceId: ws, segmentId: c.segmentId ?? null },
        senders,
        varMap,
        defs,
        defIds: defIdsFor(varMap, defs),
        lang: template.lang,
        headerOverride: !!c.headerMediaId,
      });
      transport = plan.transport;
      await this.writeCampaign(lease, {
        recipients: plan.reachable,
        skipped: plan.skipped,
        sendTransport: plan.transport,
        planCompletedAt: new Date(),
        launchStage: "sending",
        recipientTracking: true,
      });
      await job.yieldTick();
    }

    const parts = await this.partitions(lease);
    const tpl = { name: template.name, lang: template.lang };

    if (transport === "direct") {
      if (scheduledAt && scheduledAt.getTime() > Date.now()) {
        // A scheduled direct campaign waits; the scheduler starts it at scheduledAt.
        await this.writeCampaign(lease, { status: "scheduled" });
        return;
      }
      const headerMedia =
        c.headerMediaId && this.media
          ? { link: await this.media.resolveExternalUrl(ws, c.headerMediaId, this.headerTtlSeconds(scheduledAt)) }
          : undefined;
      for (const p of parts) {
        if (p.transport !== "direct" || p.stage === "sent") continue;
        job.setPartition(p.id);
        await sendDirectPartition(job, p, { template: tpl, headerMedia });
      }
      job.setPartition(null);
      await this.writeCampaign(lease, { status: "running", launchStage: "done", launchedAt: c.launchedAt ?? new Date(), lastError: null });
      await this.tracker.recountCampaign(lease.id);
      return;
    }

    const ctx = { profileId: workspace.zernioProfileId, campaignName: c.name, template: tpl, varMap, scheduledAt };
    for (const p of parts) {
      job.setPartition(p.id);
      await prepareBroadcastPartition(job, p, ctx);
      await job.yieldTick();
    }
    for (const p of parts) {
      job.setPartition(p.id);
      await sendBroadcastPartition(job, p, ctx);
    }
    job.setPartition(null);
    const first = parts.find((p) => p.zernioBroadcastId);
    const scheduled = parts.length > 0 && parts.every((p) => p.stage === "scheduled");
    await this.writeCampaign(lease, {
      status: scheduled ? "scheduled" : "running",
      launchStage: "done",
      launchedAt: new Date(),
      zernioBroadcastId: first?.zernioBroadcastId ?? null,
      lastError: null,
    });
  }

  /**
   * Cancel during launch: partitions already sent or scheduled are
   * cancelled in Zernio; drafts are deleted (a resumed runner first adopts a
   * draft it may have created); then the campaign is `cancelled`. Queued
   * rows stay queued ("Not sent"). Each call is still lease-fenced.
   */
  private async cancelLaunch(job: LaunchJob, lease: Lease): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: lease.workspaceId }, select: { zernioProfileId: true } });
    const opts = { allowCancel: true };
    let firstSent: string | null = null;
    for (const p of await this.partitions(lease)) {
      if (p.stage === "cancelled") continue;
      let bid = p.zernioBroadcastId;
      if (!bid && p.createAttemptedAt && ws?.zernioProfileId) {
        const drafts = await job.call(() => this.zernio.listBroadcasts({ profileId: ws.zernioProfileId!, status: "draft", limit: 100 }), opts);
        bid = drafts.find((b) => b.name.endsWith(` · crm:${p.id}`))?.id ?? null;
      }
      if (bid) {
        const id = bid;
        const st = await job.call(() => this.zernio.getBroadcast(id), opts);
        if (st.status === "draft") {
          await job.call(() => this.zernio.deleteBroadcast(id), opts);
          await job.updatePartition(p.id, { stage: "cancelled", zernioBroadcastId: null }, opts);
          continue;
        }
        if (!["cancelled", "completed", "failed"].includes(st.status)) await job.call(() => this.zernio.cancelBroadcast(id), opts);
        firstSent ??= id;
      }
      await job.updatePartition(p.id, { stage: "cancelled" }, opts);
    }
    await this.writeCampaign(
      lease,
      { status: "cancelled", launchStage: "done", ...(firstSent ? { zernioBroadcastId: firstSent, launchedAt: new Date() } : {}) },
      opts,
    );
  }

  /**
   * Transient: stay `launching` (the scheduler resumes a stale lease) until
   * MAX_LAUNCH_ATTEMPTS. Otherwise `failed` with a keyed `lastError`
   * (`campaigns.*`, else `campaigns.launch_failed`; the provider's text goes
   * on the partition's `lastError`) and a notification to the launcher. Any
   * partition already sent stays tracked (its broadcast becomes the
   * campaign's `zernioBroadcastId`, so the sweep follows it).
   */
  private async fail(lease: Lease, e: unknown): Promise<void> {
    this.log.error(`campaign launch ${lease.id} failed: ${(e as Error).message}`);
    try {
      const attempts = lease.launchAttempts + 1;
      const fence = { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat };
      const key = campaignErrorKey(e);
      const noteOnPartition = async () => {
        if (lease.partitionId && !key) {
          await this.prisma.campaignBroadcast.updateMany({
            where: { id: lease.partitionId, workspaceId: lease.workspaceId },
            data: { lastError: String((e as Error)?.message ?? e).slice(0, 300) },
          });
        }
      };
      if (isTransientLaunchError(e) && attempts < MAX_LAUNCH_ATTEMPTS) {
        const res = await this.prisma.campaign.updateMany({ where: fence, data: { launchAttempts: attempts } });
        if (res.count === 1) await noteOnPartition();
        return;
      }
      const error = key ?? "campaigns.launch_failed";
      const sent = (await this.partitions(lease)).find((p) => p.zernioBroadcastId && ["sent", "scheduled"].includes(p.stage));
      const res = await this.prisma.campaign.updateMany({
        where: fence,
        data: {
          status: "failed",
          launchStage: "failed",
          lastError: error,
          launchAttempts: attempts,
          ...(sent ? { zernioBroadcastId: sent.zernioBroadcastId, launchedAt: new Date() } : {}),
        },
      });
      if (res.count !== 1) return;
      await noteOnPartition();
      if (lease.launchedById && this.notifications) {
        await this.notifications.notify(lease.workspaceId, [lease.launchedById], {
          type: "campaign_finished",
          title: "campaign.launch_failed",
          body: JSON.stringify({ name: lease.name, error }),
          recordKind: "campaign",
          recordId: lease.id,
        });
      }
    } catch (inner) {
      this.log.error(`campaign launch ${lease.id} failure handling crashed: ${(inner as Error).message}`);
    }
  }
}
