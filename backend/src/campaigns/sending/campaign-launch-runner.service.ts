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
    const fence = async (opts: { allowCancel?: boolean; progress?: boolean } = {}) => {
      const next = nextBeat(lease.beat);
      // Fix round 1 (I3): durable progress resets the attempt counter, so
      // MAX_LAUNCH_ATTEMPTS counts consecutive failures without progress.
      const reset = opts.progress && lease.launchAttempts > 0;
      const res = await prisma.campaign.updateMany({
        where: { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat, ...(opts.allowCancel ? {} : { cancelRequestedAt: null }) },
        data: { launchHeartbeatAt: next, ...(reset ? { launchAttempts: 0 } : {}) },
      });
      if (res.count === 1) {
        lease.beat = next;
        if (reset) lease.launchAttempts = 0;
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
          // Fix round 1 (m3): a 429 is team-wide; hold every caller of the bucket.
          onRateLimit: (ms) => this.budget.campaign.pause(ms),
          before: async () => {
            await this.budget.campaign.take();
            if (opts.direct) await this.budget.direct.take();
            await fence({ allowCancel: opts.allowCancel });
          },
        }),
      updatePartition: async (pid, data, opts = {}) => {
        await fence({ allowCancel: opts.allowCancel, progress: opts.progress ?? true });
        await prisma.campaignBroadcast.update({ where: { id: pid }, data });
      },
      setPartition: (pid) => (lease.partitionId = pid),
      yieldTick: () => this.yieldTick(),
      now: () => Date.now(),
      pageSize: this.pageSize,
      importPageSize: this.importPageSize,
      addPageSize: this.addPageSize,
      directPageSize: this.directPageSize,
      rejectStreak: { count: 0, message: null },
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
      if (typeof data.launchAttempts === "number") lease.launchAttempts = data.launchAttempts;
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
        launchAttempts: 0,
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
      for (const p of parts) {
        if (p.transport !== "direct" || p.stage === "sent") continue;
        job.setPartition(p.id);
        const headerMedia = c.headerMediaId ? { link: await this.headerLink(job, p, ws, c.headerMediaId, scheduledAt) } : undefined;
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
   * Fix round 1 (I4): the header link of a direct partition is resolved
   * ONCE and stored on the partition as `variables.__headerLink` (with
   * `__headerLinkExpiresAt`), then reused on every retry and resume. A fresh
   * presigned URL per run would change the request body under the same
   * Idempotency-Key. Our own `/api/media/:id/public` route needs an expiring
   * token, so there is no stable non-expiring link to use instead. The
   * ruling-9 TTL (72 h past the send, at most 7 days) covers the 23 h
   * resume window.
   */
  private async headerLink(job: LaunchJob, p: PartitionRow, ws: string, mediaId: string, scheduledAt: Date | null): Promise<string> {
    const vars = (p.variables && typeof p.variables === "object" ? p.variables : {}) as Record<string, unknown>;
    if (typeof vars.__headerLink === "string" && vars.__headerLink) return vars.__headerLink;
    if (!this.media) throw new HttpException("Media service unavailable", 500);
    const ttl = this.headerTtlSeconds(scheduledAt);
    const link = await this.media.resolveExternalUrl(ws, mediaId, ttl);
    const next = { ...vars, __headerLink: link, __headerLinkExpiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    await job.updatePartition(p.id, { variables: next }, { progress: false });
    p.variables = next;
    return link;
  }

  /**
   * Stops one partition in Zernio, as far as it can go out:
   * - a draft is deleted when `deleteDrafts` (cancel), else left (a draft never sends);
   * - a broadcast still scheduled or sending is cancelled;
   * - a finished one is left as it is.
   * Zernio errors propagate (the callers decide per partition: 404 = gone).
   */
  private async stopPartition(
    job: LaunchJob,
    p: PartitionRow,
    opts: { profileId: string | null; deleteDrafts: boolean },
  ): Promise<"gone" | "draft" | "stopped" | "finished"> {
    const call = <T>(fn: () => Promise<T>) => job.call(fn, { allowCancel: true });
    const write = (data: Record<string, unknown>) => job.updatePartition(p.id, data, { allowCancel: true, progress: false });
    let bid = p.zernioBroadcastId;
    if (!bid && p.createAttemptedAt && opts.profileId && opts.deleteDrafts) {
      const profileId = opts.profileId;
      const drafts = await call(() => this.zernio.listBroadcasts({ profileId, status: "draft", limit: 100 }));
      bid = drafts.find((b) => b.name.endsWith(` · crm:${p.id}`))?.id ?? null;
    }
    if (!bid) {
      if (opts.deleteDrafts) await write({ stage: "cancelled" });
      return "gone";
    }
    const id = bid;
    const st = await call(() => this.zernio.getBroadcast(id));
    if (st.status === "draft") {
      if (!opts.deleteDrafts) return "draft";
      await call(() => this.zernio.deleteBroadcast(id));
      await write({ stage: "cancelled", zernioBroadcastId: null });
      return "gone";
    }
    if (FINISHED_BROADCAST.includes(st.status)) {
      if (opts.deleteDrafts) await write({ stage: "cancelled" });
      return "finished";
    }
    await call(() => this.zernio.cancelBroadcast(id));
    await write({ stage: "cancelled" });
    return "stopped";
  }

  /**
   * Cancel during launch, per partition (fix round 1, I2): drafts are
   * deleted (a resumed runner first adopts a draft it may have created),
   * broadcasts already scheduled or sending are cancelled. A 404 means the
   * broadcast is gone. Any other error is noted on that partition's
   * `lastError` and the others go on. While a partition failed transiently,
   * the job stays `launching` for the next resume (an attempt is counted);
   * the end state is always `cancelled`, never `failed`, with the notes left
   * on partitions that could not be confirmed. Queued rows stay queued.
   */
  private async cancelLaunch(job: LaunchJob, lease: Lease): Promise<void> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: lease.workspaceId }, select: { zernioProfileId: true } });
    const opts = { allowCancel: true, progress: false };
    let pending = false;
    let firstOut: string | null = null;
    for (const p of await this.partitions(lease)) {
      if (p.stage === "cancelled") {
        if (p.zernioBroadcastId) firstOut ??= p.zernioBroadcastId;
        continue;
      }
      try {
        const r = await this.stopPartition(job, p, { profileId: ws?.zernioProfileId ?? null, deleteDrafts: true });
        if ((r === "stopped" || r === "finished") && p.zernioBroadcastId) firstOut ??= p.zernioBroadcastId;
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        if (isNotFound(e)) {
          await job.updatePartition(p.id, { stage: "cancelled", zernioBroadcastId: null }, opts);
          continue;
        }
        await job.updatePartition(p.id, { lastError: `cancel: ${errorText(e)}` }, opts);
        if (isTransientLaunchError(e)) pending = true;
      }
    }
    if (pending && lease.launchAttempts + 1 < MAX_LAUNCH_ATTEMPTS) {
      // Retried by the next resume; the other partitions are already handled.
      await this.writeCampaign(lease, { launchAttempts: lease.launchAttempts + 1 }, { allowCancel: true });
      return;
    }
    await this.writeCampaign(
      lease,
      { status: "cancelled", launchStage: "done", ...(firstOut ? { zernioBroadcastId: firstOut, launchedAt: new Date() } : {}) },
      { allowCancel: true },
    );
  }

  /**
   * Transient: stay `launching` (the scheduler resumes a stale lease) until
   * MAX_LAUNCH_ATTEMPTS consecutive failures without progress.
   *
   * A cancel requested meanwhile always wins: the cleanup runs instead and
   * the campaign ends `cancelled`, never `failed` (fix round 1, I2).
   *
   * Otherwise (fix round 1, I1) every partition that may still go out is
   * stopped in Zernio first, each independently and best-effort (a failure
   * is noted on that partition), then the campaign is `failed` with a keyed
   * `lastError` (`campaigns.*`, else `campaigns.launch_failed`; the
   * provider's text on the partition) and the launcher is notified. A
   * partition that could not be stopped keeps the failed campaign
   * cancellable (`CampaignSendService.cancel`) and undeletable. A direct
   * campaign is recounted once (m4).
   */
  private async fail(lease: Lease, e: unknown): Promise<void> {
    this.log.error(`campaign launch ${lease.id} failed: ${(e as Error).message}`);
    try {
      const cur = await this.prisma.campaign.findFirst({
        where: { id: lease.id },
        select: { cancelRequestedAt: true, sendTransport: true, status: true },
      });
      if (!cur || cur.status !== "launching") return;
      const job = this.job(lease);
      if (cur.cancelRequestedAt) {
        try {
          await this.cancelLaunch(job, lease);
        } catch (inner) {
          if (inner instanceof LeaseLost) return;
          const attempts = lease.launchAttempts + 1;
          await this.writeCampaign(
            lease,
            attempts < MAX_LAUNCH_ATTEMPTS ? { launchAttempts: attempts } : { status: "cancelled", launchStage: "done", launchAttempts: attempts },
            { allowCancel: true },
          );
        }
        return;
      }

      const attempts = lease.launchAttempts + 1;
      const key = campaignErrorKey(e);
      const noteOnPartition = async () => {
        if (lease.partitionId && !key) {
          await this.prisma.campaignBroadcast.updateMany({
            where: { id: lease.partitionId, workspaceId: lease.workspaceId },
            data: { lastError: errorText(e) },
          });
        }
      };
      if (isTransientLaunchError(e) && attempts < MAX_LAUNCH_ATTEMPTS) {
        const res = await this.prisma.campaign.updateMany({
          where: { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat },
          data: { launchAttempts: attempts },
        });
        if (res.count === 1) await noteOnPartition();
        return;
      }

      await noteOnPartition();
      // I1: nothing may keep going out once the campaign reads `failed`.
      for (const p of await this.partitions(lease)) {
        if (!p.zernioBroadcastId || p.stage === "cancelled" || p.transport !== "broadcast") continue;
        try {
          await this.stopPartition(job, p, { profileId: null, deleteDrafts: false });
        } catch (x) {
          if (x instanceof LeaseLost) return;
          if (isNotFound(x)) await job.updatePartition(p.id, { stage: "cancelled" }, { allowCancel: true, progress: false });
          else await job.updatePartition(p.id, { lastError: `cancel: ${errorText(x)}` }, { allowCancel: true, progress: false });
        }
      }
      const error = key ?? "campaigns.launch_failed";
      const out = (await this.partitions(lease)).find((p) => p.zernioBroadcastId && ["sent", "scheduled", "cancelled"].includes(p.stage));
      const res = await this.prisma.campaign.updateMany({
        where: { id: lease.id, status: "launching", launchHeartbeatAt: lease.beat },
        data: {
          status: "failed",
          launchStage: "failed",
          lastError: error,
          launchAttempts: attempts,
          ...(out ? { zernioBroadcastId: out.zernioBroadcastId, launchedAt: new Date() } : {}),
        },
      });
      if (res.count !== 1) return;
      // m4: rows a direct campaign already sent show in its counters.
      if (cur.sendTransport === "direct") await this.tracker.recountCampaign(lease.id);
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

  /** In-flight campaign ids (the scheduler skips them in its query). */
  runningIds(): string[] {
    return [...this.inFlight];
  }
}

/** Zernio statuses after which a broadcast sends nothing more. */
export const FINISHED_BROADCAST = ["completed", "failed", "cancelled"];

export const isNotFound = (e: unknown) => e instanceof HttpException && e.getStatus() === 404;
const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
