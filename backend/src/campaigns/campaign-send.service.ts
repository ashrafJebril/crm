import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { type Campaign, Prisma } from "@prisma/client";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioBroadcastVariable, ZernioClient } from "../integrations/zernio.client";
import { assertHeaderMedia } from "../integrations/template-header";
import { MediaService } from "../media/media.service";
import type { Viewer } from "../permissions/visibility";
import { RecipientTrackerService } from "./tracking/recipient-tracker.service";
import { campaignError } from "./campaign-errors";
import { buildRecipients, campaignStatusFor, estimateMetaCost, templatePlaceholderCount } from "./campaign-audience";
import { CampaignLaunchRunner, FINISHED_BROADCAST, isNotFound } from "./sending/campaign-launch-runner.service";
import { budgeted, ZernioBudget } from "./sending/zernio-budget";
import { aggregateBroadcastStatus } from "./sending/broadcast-status";
import { loadCustomDefs, resolveLaunchSenders, templateUnsupported } from "./sending/launch-context";
import { type AudienceResolver, resolveCampaignAudience, streamAudience } from "./sending/audience-stream";
import { SegmentsService } from "../segments/segments.service";
import { effectiveSenderIds, templateOnSenders } from "./sending/senders";
import { legacyToVarMap, validateVarMap } from "./sending/var-map";

/** Ruling 9: a campaign with a header file is scheduled at most this many days ahead. */
export const HEADER_SCHEDULE_MAX_DAYS = 6;

/** SP-12: recipient rows per createMany at launch (never one giant insert). */
export const RECIPIENT_WRITE_CHUNK = 1000;
/** A finished tracked campaign is still swept this long after launch, for late reads and failure codes. */
export const RECIPIENT_SWEEP_TAIL_MS = 72 * 3_600_000;
/** A finished campaign whose pass already ended is swept again at most this often (fix round 2, R1). */
export const RECIPIENT_TAIL_INTERVAL_MS = 3_600_000;

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Rows per Zernio recipients page. 100 until the Task 4 probe shows the real maximum (ruling 1). */
export const recipientPageSize = () => positiveInt(process.env.ZERNIO_RECIPIENT_PAGE, 100);
/** Fix I2: pages one explicit Refresh may sweep for its campaign. */
export const REFRESH_SWEEP_MAX_PAGES = 5;
/** Pages per campaign per 5-minute tick. */
export const recipientSyncMaxPages = () => positiveInt(process.env.RECIPIENT_SYNC_MAX_PAGES, 50);

const ACTIVE = ["scheduled", "running"];
const FINISHED = ["completed", "failed", "cancelled"];
/** SP-13: partitions Zernio has (or had) sending: swept and read for status. */
const SWEPT_STAGES = ["sent", "scheduled", "completed", "cancelled"];

interface SweepCampaign {
  id: string;
  workspaceId: string;
  zernioBroadcastId: string | null;
  status?: string | null;
  recipients?: number | null;
  recipientSyncSkip?: number | null;
  recipientsSyncedAt?: Date | null;
  sendTransport?: string | null;
}

interface SweepPartition {
  id: string;
  campaignId: string;
  zernioBroadcastId: string;
  recipientSyncSkip: number | null;
  recipientsSyncedAt: Date | null;
  recipientCount: number | null;
}

/** One broadcast the sweep pages: a legacy campaign (key = its id) or one SP-13 partition. */
interface SweepUnit {
  key: string;
  c: SweepCampaign;
  broadcastId: string;
  skip: number;
  syncedAt: Date | null;
  expected: number;
  partition: SweepPartition | null;
}

export interface LaunchInput {
  mode: "now" | "schedule";
  scheduledAt?: string;
  /** Legacy body variables (SP-13 makes them optional; Task 2 reads Campaign.varMap). */
  variables?: ZernioBroadcastVariable[];
}

/**
 * Sends a campaign as a Zernio WhatsApp broadcast.
 *
 * Meta bills each message to the workspace's own WhatsApp Business Account;
 * the payment lock stops a workspace behind on its Kewy subscription from
 * launching. Zernio owns delivery, and a five-minute sync copies its
 * counters back onto the campaign.
 */
@Injectable()
export class CampaignSendService {
  private readonly log = new Logger(CampaignSendService.name);

  private readonly tracker: RecipientTrackerService;
  /** SP-13: the background launch runner (module singleton; hand-built specs get one over the same Prisma). */
  readonly launcher: CampaignLaunchRunner;
  /** Zernio budget for per-partition status reads (fix round 1, m3); process-wide by default. */
  budget: ZernioBudget = ZernioBudget.shared();
  /** SP-16 (F1): resolves a campaign's audience (smart audiences through the compiler). */
  private readonly segments: AudienceResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    private readonly paymentLock: PaymentLockService,
    // From CampaignTrackingModule; hand-built specs get one over the same Prisma.
    @Optional() tracker?: RecipientTrackerService,
    @Optional() launcher?: CampaignLaunchRunner,
    @Optional() private readonly media?: MediaService,
    // Required by Nest (SegmentsModule provides it); hand-built specs may pass a stub or nothing.
    segments?: SegmentsService,
  ) {
    this.tracker = tracker ?? new RecipientTrackerService(prisma);
    this.segments = segments ?? new SegmentsService(prisma);
    this.launcher = launcher ?? new CampaignLaunchRunner(prisma, zernio, media, undefined, this.tracker, segments);
  }

  /**
   * Who a segment (or everyone) would reach, and roughly what Meta will charge
   * (legacy `GET /campaigns/preview`; same response shape as before).
   *
   * SP-16: the audience resolves through the same resolver as the newer
   * preview and the launch (a deleted segment → 400 campaigns.audience_missing),
   * and is read in keyset pages of AUDIENCE_PAGE (review m3), never loaded
   * whole: only the per-page counts and the phone de-duplication set are kept.
   */
  async preview(workspaceId: string, segmentId: string | null) {
    const where = await resolveCampaignAudience(this.segments, workspaceId, segmentId, new Date());
    const seen = new Set<string>();
    const skipped = { noPhone: 0, optedOut: 0, duplicate: 0 };
    const estimate = { usd: 0, unpriced: 0 };
    let total = 0;
    let reachable = 0;
    for await (const page of streamAudience(this.prisma, workspaceId, where, [])) {
      total += page.contacts.length;
      const built = buildRecipients(page.contacts, seen);
      skipped.noPhone += built.skipped.noPhone;
      skipped.optedOut += built.skipped.optedOut;
      skipped.duplicate += built.skipped.duplicate;
      reachable += built.recipients.length;
      const cost = estimateMetaCost(built.recipients.map((r) => r.phone));
      estimate.usd += cost.usd;
      estimate.unpriced += cost.unpriced;
    }
    return { total, reachable, skipped, estimate };
  }

  /**
   * SP-13 (SP-12 R10): validate, claim the draft as `launching`, kick the
   * background runner, and answer at once (202) with the campaign. Every
   * check that needs no audience runs here, in the plan's order:
   * 1. payment lock; 2. 404 `campaigns.not_found`; 3. 409
   * `campaigns.already_launched`; 4. `campaigns.schedule_invalid`;
   * 5. `campaigns.template_paused` / `campaigns.template_disabled` (SP-14),
   * then `campaigns.template_not_approved`; 6. `campaigns.template_unsupported`
   * (ruling 12); 7. 409 `campaigns.whatsapp_not_connected`; 8. senders
   * (`channels.sender_invalid`, `campaigns.too_many_senders`); 9. the
   * template on every sender (502 `campaigns.template_check_failed`, then
   * SP-14's `campaigns.template_paused_on_number`, then
   * `campaigns.template_missing_on_number`); 10. the varMap (`var_map_invalid`;
   * legacy body `variables` convert when the campaign has none); 11. the
   * header file (MediaService.get as the launcher, `assertHeaderMedia`, at
   * most 6 days ahead, ruling 9); 12. the audience (SP-16: a deleted segment
   * → 400 `campaigns.audience_missing {segmentId}`).
   * The claim is a compare-and-set on the draft, so a second click gets 409.
   * Audience checks (nobody reachable, too varied) fail the job later.
   */
  async launch(workspaceId: string, id: string, input: LaunchInput, viewer?: Viewer) {
    if (await this.paymentLock.isLocked(workspaceId)) {
      throw new BadRequestException("Sending is paused until the overdue payment for this workspace is settled.");
    }
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw campaignError("campaigns.not_found");
    if (campaign.status !== "draft" || campaign.zernioBroadcastId) throw campaignError("campaigns.already_launched");

    let scheduledAt: Date | null = null;
    if (input.mode === "schedule") {
      scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        throw campaignError("campaigns.schedule_invalid");
      }
    }

    const template = campaign.templateId
      ? await this.prisma.template.findFirst({ where: { id: campaign.templateId, workspaceId } })
      : null;
    // SP-14 (ruling 10): a paused or disabled template has its own key, before not_approved.
    if (template?.status === "paused") throw campaignError("campaigns.template_paused");
    if (template?.status === "disabled") throw campaignError("campaigns.template_disabled");
    if (!template || template.status !== "approved") throw campaignError("campaigns.template_not_approved");
    if (templateUnsupported(template)) throw campaignError("campaigns.template_unsupported");

    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { zernioProfileId: true } });
    // SP-13 ruling 6: one key for every marketing action (409, code WHATSAPP_NOT_CONNECTED).
    if (!workspace?.zernioProfileId) throw campaignError("campaigns.whatsapp_not_connected");
    const senders = await resolveLaunchSenders(this.prisma, workspaceId, effectiveSenderIds(campaign));
    if (senders.length === 0) throw campaignError("campaigns.whatsapp_not_connected");

    const onSenders = await templateOnSenders(this.zernio, senders, { name: template.name, lang: template.lang }, { budget: this.budget.campaign });
    if (onSenders.failed.length > 0) throw campaignError("campaigns.template_check_failed", { channelIds: onSenders.failed });
    if (onSenders.paused.length > 0) {
      throw campaignError("campaigns.template_paused_on_number", {
        channelIds: onSenders.paused.map((p) => p.channelId),
        statuses: Object.fromEntries(onSenders.paused.map((p) => [p.channelId, p.status])),
      });
    }
    if (onSenders.missing.length > 0) throw campaignError("campaigns.template_missing_on_number", { channelIds: onSenders.missing });

    const rawMap = campaign.varMap ?? legacyToVarMap(input.variables ?? []);
    const defs = await loadCustomDefs(this.prisma, workspaceId);
    const varMap = validateVarMap(rawMap, { slotCount: templatePlaceholderCount(template.body), customDefs: defs });

    if (campaign.headerMediaId) {
      if (!this.media) throw new NotFoundException("Media not found");
      const row = await this.media.get(workspaceId, campaign.headerMediaId, viewer);
      assertHeaderMedia(row, template.headerType);
      if (scheduledAt && scheduledAt.getTime() - Date.now() > HEADER_SCHEDULE_MAX_DAYS * 24 * 3_600_000) {
        throw campaignError("campaigns.header_media_schedule_too_far", { days: HEADER_SCHEDULE_MAX_DAYS });
      }
    }

    // SP-16 (F1): refuse a campaign whose audience is gone before claiming it.
    // The job resolves it again at its plan start (and fails with the same key).
    await resolveCampaignAudience(this.segments, workspaceId, campaign.segmentId, new Date());

    const claimed = await this.prisma.campaign.updateMany({
      where: { id, workspaceId, status: "draft", zernioBroadcastId: null },
      data: {
        status: "launching",
        launchStage: "planning",
        launchHeartbeatAt: new Date(),
        launchAttempts: 0,
        launchedById: viewer?.userId ?? null,
        scheduledAt,
        varMap: varMap as unknown as Prisma.InputJsonValue,
        // History (SP-12 and main read it): the legacy body when one was sent.
        ...(input.variables ? { variableMapping: input.variables as unknown as Prisma.InputJsonValue } : {}),
        planCompletedAt: null,
        cancelRequestedAt: null,
        sendTransport: null,
        lastError: null,
      },
    });
    if (claimed.count !== 1) throw campaignError("campaigns.already_launched");
    this.launcher.kick(id);
    return (await this.prisma.campaign.findFirst({ where: { id, workspaceId } }))!;
  }

  /**
   * - `launching`: records `cancelRequestedAt`; the runner (or its resume)
   *   deletes drafts and cancels sent partitions, then ends `cancelled`.
   * - a scheduled direct campaign still waiting: `cancelled` at once.
   * - SP-13 multi-broadcast (`sendTransport: broadcast`): every sent or
   *   scheduled partition is cancelled in Zernio.
   * - otherwise the legacy single broadcast, unchanged.
   * 400 `campaigns.not_cancellable` when nothing is sending.
   */
  /** SP-13: partitions that may still send (by our records): a Zernio id and stage sent or scheduled. */
  private livePartitions(workspaceId: string, campaignId: string): Promise<Array<{ id: string; zernioBroadcastId: string }>> {
    return this.prisma.campaignBroadcast.findMany({
      where: { workspaceId, campaignId, zernioBroadcastId: { not: null }, stage: { in: ["sent", "scheduled"] } },
      select: { id: true, zernioBroadcastId: true },
    }) as Promise<Array<{ id: string; zernioBroadcastId: string }>>;
  }

  /**
   * Whether `cancel` has something to stop (GET /campaigns/:id `canCancel`):
   * a launching campaign; a waiting scheduled direct one; a scheduled or
   * running one with a broadcast; a failed SP-13 campaign that still has a
   * partition that may send (fix round 1, I1). Database only, no Zernio call.
   */
  async cancellable(workspaceId: string, id: string): Promise<boolean> {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw campaignError("campaigns.not_found");
    const live = needsLiveCheck(c) && (await this.livePartitions(workspaceId, id)).length > 0;
    return cancellableRule(c, live);
  }

  /**
   * SP-13 final review (I2): `cancellable` for a whole list page. One
   * grouped query finds which of the page's broadcast campaigns still have a
   * partition that may send; none runs when no row needs it. Keyed by id.
   */
  async cancellableMany(workspaceId: string, campaigns: readonly CancellableShape[]): Promise<Map<string, boolean>> {
    const ids = campaigns.filter(needsLiveCheck).map((c) => c.id);
    const live = new Set<string>();
    if (ids.length > 0) {
      const groups = (await this.prisma.campaignBroadcast.groupBy({
        by: ["campaignId"],
        where: { workspaceId, campaignId: { in: ids }, zernioBroadcastId: { not: null }, stage: { in: ["sent", "scheduled"] } },
      })) as unknown as Array<{ campaignId: string }>;
      for (const g of groups) live.add(g.campaignId);
    }
    return new Map(campaigns.map((c) => [c.id, cancellableRule(c, live.has(c.id))]));
  }

  /**
   * Fix round 1 (I1): a campaign may not be deleted while one of its
   * broadcasts may still send (the cascade would drop the only record of
   * it). Each partition our records call sent or scheduled is read from
   * Zernio (budgeted): finished or gone (404) is fine; anything else, or an
   * unreadable one, refuses with 400 `campaigns.has_live_broadcasts`.
   */
  async assertDeletable(workspaceId: string, id: string): Promise<void> {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw campaignError("campaigns.not_found");
    if (c.sendTransport !== "broadcast") return;
    for (const p of await this.livePartitions(workspaceId, id)) {
      try {
        const st = await budgeted(this.budget.campaign, () => this.zernio.getBroadcast(p.zernioBroadcastId));
        if (FINISHED_BROADCAST.includes(st.status)) continue;
      } catch (e) {
        if (isNotFound(e)) continue;
      }
      throw campaignError("campaigns.has_live_broadcasts");
    }
  }

  async cancel(workspaceId: string, id: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw campaignError("campaigns.not_found");
    const reread = async () => (await this.prisma.campaign.findFirst({ where: { id, workspaceId } }))!;
    if (campaign.status === "launching") {
      const res = await this.prisma.campaign.updateMany({
        where: { id, workspaceId, status: "launching" },
        data: { cancelRequestedAt: new Date() },
      });
      if (res.count === 1) return reread();
      return this.cancel(workspaceId, id);
    }
    if (campaign.sendTransport === "direct" && campaign.status === "scheduled") {
      const res = await this.prisma.campaign.updateMany({
        where: { id, workspaceId, status: "scheduled", sendTransport: "direct" },
        data: { status: "cancelled", launchStage: "done" },
      });
      if (res.count === 1) return reread();
      return this.cancel(workspaceId, id);
    }
    // SP-13: every partition that may still send, also on a launch that
    // ended failed with one still live (fix round 1, I1).
    if (campaign.sendTransport === "broadcast" && ["scheduled", "running", "failed", "cancelled"].includes(campaign.status)) {
      const parts = await this.livePartitions(workspaceId, id);
      if (parts.length > 0) {
        let firstError: unknown = null;
        for (const p of parts) {
          try {
            const st = await budgeted(this.budget.campaign, () => this.zernio.getBroadcast(p.zernioBroadcastId));
            if (!FINISHED_BROADCAST.includes(st.status)) {
              await budgeted(this.budget.campaign, () => this.zernio.cancelBroadcast(p.zernioBroadcastId));
            }
            await this.prisma.campaignBroadcast.update({ where: { id: p.id }, data: { stage: "cancelled" } });
          } catch (e) {
            if (isNotFound(e)) {
              await this.prisma.campaignBroadcast.update({ where: { id: p.id }, data: { stage: "cancelled" } });
              continue;
            }
            firstError ??= e;
            await this.prisma.campaignBroadcast.update({
              where: { id: p.id },
              data: { lastError: `cancel: ${String((e as Error)?.message ?? e).slice(0, 290)}` },
            });
          }
        }
        // A partition that could not be stopped keeps the campaign as it was: try again.
        if (firstError) throw firstError;
        return this.prisma.campaign.update({ where: { id }, data: { status: "cancelled" } });
      }
    }
    if (!campaign.zernioBroadcastId || !["scheduled", "running"].includes(campaign.status)) {
      throw campaignError("campaigns.not_cancellable");
    }
    await this.zernio.cancelBroadcast(campaign.zernioBroadcastId);
    return this.prisma.campaign.update({ where: { id }, data: { status: "cancelled" } });
  }

  /**
   * Pull one campaign's latest status and counters from Zernio, then (fix
   * I2) a bounded sweep of its recipients: at most REFRESH_SWEEP_MAX_PAGES
   * pages from its stored offset, through the same tracker as the cron. It
   * shares the cron's `syncing` guard, so the two never overlap: while a tick
   * is running the sweep is skipped (that tick is already sweeping) and the
   * current state is returned. A failing sweep never fails the refresh.
   */
  async refresh(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw campaignError("campaigns.not_found");
    // SP-13 direct sends have no broadcast: the rows are the truth.
    if (campaign.sendTransport === "direct" && campaign.recipientTracking && ["running", "completed"].includes(campaign.status)) {
      await this.tracker.recountCampaign(campaign.id);
      return (await this.prisma.campaign.findFirst({ where: { id, workspaceId } })) ?? campaign;
    }
    if (!campaign.zernioBroadcastId) return campaign;
    const updated = await this.statsFor(campaign);
    if (updated.recipientTracking !== true || this.syncing) return updated;
    this.syncing = true;
    try {
      await this.sweepAll([updated], { maxPages: REFRESH_SWEEP_MAX_PAGES, force: true });
    } catch (e) {
      this.log.warn(`campaign ${campaign.id} refresh sweep failed: ${(e as Error).message}`);
      return updated;
    } finally {
      this.syncing = false;
    }
    return (await this.prisma.campaign.findFirst({ where: { id: campaign.id, workspaceId } })) ?? updated;
  }

  /**
   * Zernio's aggregate counters apply to untracked (pre-SP-12) campaigns,
   * and to tracked ones until their first full sweep pass completes (fix I1).
   * After that the counters come from the rows (ruling 5).
   */
  private useAggregates(c: { recipientTracking?: boolean | null; recipientsSyncedAt?: Date | null }): boolean {
    return c.recipientTracking !== true || !c.recipientsSyncedAt;
  }

  /** Re-entrancy guard: @nestjs/schedule does not prevent overlapping ticks. */
  private syncing = false;
  /** R1: when each campaign last got a page in this process (a sequence number), for rotation. */
  private readonly lastPagedAt = new Map<string, number>();
  private pageSeq = 0;
  /** R1: when each campaign's last pass ended in this process (covered or not), for the hourly tail. */
  private readonly passEndedAt = new Map<string, number>();

  /**
   * Every 5 minutes, in two phases (fix I3):
   * 1. Zernio's status (and, while `useAggregates`, its counters) for every
   *    active (scheduled/running) campaign, so status flips are never held
   *    back by sweeps;
   * 2. the recipient sweeps of tracked campaigns that are active or within
   *    72 h of their effective send time `COALESCE(scheduledAt, launchedAt)`
   *    (fix I2), sharing one page budget round-robin.
   * An overlapping tick returns at once.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncActive(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const tailSince = new Date(Date.now() - RECIPIENT_SWEEP_TAIL_MS);
      const rows = await this.prisma.campaign.findMany({
        where: {
          zernioBroadcastId: { not: null },
          OR: [
            { status: { in: ACTIVE } },
            {
              recipientTracking: true,
              status: { in: FINISHED },
              OR: [{ scheduledAt: { gte: tailSince } }, { scheduledAt: null, launchedAt: { gte: tailSince } }],
            },
          ],
        },
        select: {
          id: true,
          workspaceId: true,
          zernioBroadcastId: true,
          status: true,
          recipientTracking: true,
          recipientSyncSkip: true,
          recipientsSyncedAt: true,
          recipients: true,
          sendTransport: true,
        },
      });
      for (const c of rows) {
        if (FINISHED.includes(c.status as string)) continue;
        try {
          await this.statsFor(c);
        } catch (e) {
          this.log.warn(`campaign ${c.id} stats sync failed: ${(e as Error).message}`);
        }
      }
      await this.sweepAll(rows.filter((c) => c.recipientTracking === true));
    } catch (e) {
      this.log.warn(`campaign sync failed: ${(e as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * SP-12 pull sweep (the source of truth, ruling 1). Pages of
   * ZERNIO_RECIPIENT_PAGE rows, taken round-robin across campaigns from each
   * one's `recipientSyncSkip`, at most RECIPIENT_SYNC_MAX_PAGES pages per
   * tick in total, so one huge campaign cannot starve the others.
   *
   * A campaign's pass ends on an empty page, `hasMore: false`, a page shorter
   * than the page size, or `skip >= total` when Zernio reports a total. A
   * missing `hasMore` on a full page means there is more (fix I1). At the end
   * of the tick each campaign stores its offset (reset to 0 and
   * `recipientsSyncedAt` set when its pass ended) and, when rows changed or
   * the pass ended, is recounted: exactly after a first full pass, otherwise
   * only upwards while Zernio's aggregates are still in use. A failing
   * campaign keeps its offset and does not stop the others.
   *
   * Fix round 2:
   * - R1 fairness: campaigns are taken least-recently-paged first (this
   *   process's memory), then `recipientsSyncedAt` ASC NULLS FIRST, then id,
   *   so the start rotates every tick. A finished (tail) campaign whose pass
   *   ended less than an hour ago is not swept at all.
   * - R2: an explicit `hasMore` is trusted; the short-page and total rules
   *   apply only when Zernio does not report it.
   * - R3: `recipientsSyncedAt` is set only when the ended pass covered at
   *   least `Campaign.recipients` rows; otherwise the pass restarts at 0 and
   *   Zernio's counters stay in use.
   *
   * Fix I2: `refresh` calls this for one campaign with `maxPages` as its own
   * budget and `force` to skip the hourly tail throttle.
   */
  private async sweepAll(campaigns: SweepCampaign[], opts: { maxPages?: number; force?: boolean } = {}): Promise<void> {
    const limit = recipientPageSize();
    let budget = opts.maxPages ?? recipientSyncMaxPages();
    const now = Date.now();
    const units = await this.sweepUnits(campaigns.filter((c) => c.zernioBroadcastId));
    const tailDue = (u: SweepUnit) => {
      if (opts.force || !FINISHED.includes(u.c.status as string)) return true;
      const lastEnd = Math.max(u.syncedAt?.getTime() ?? 0, this.passEndedAt.get(u.key) ?? 0);
      return now - lastEnd >= RECIPIENT_TAIL_INTERVAL_MS;
    };
    const synced = (u: SweepUnit) => u.syncedAt?.getTime() ?? -1;
    const state = units
      .filter(tailDue)
      .sort(
        (a, b) =>
          (this.lastPagedAt.get(a.key) ?? 0) - (this.lastPagedAt.get(b.key) ?? 0) ||
          synced(a) - synced(b) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      )
      .map((u) => ({ u, c: u.c, skip: u.skip, finished: false, failed: false, changed: 0, pages: 0 }));
    let open = state;
    while (budget > 0 && open.length > 0) {
      for (const s of open) {
        if (budget <= 0) break;
        budget--;
        s.pages++;
        this.lastPagedAt.set(s.u.key, ++this.pageSeq);
        try {
          // Final review (R19): every page shares the campaign budget; a 429 pauses it.
          const res = await budgeted(this.budget.campaign, () => this.zernio.listBroadcastRecipients(s.u.broadcastId, { skip: s.skip, limit }));
          const applied = await this.tracker.applyBroadcastPage({ id: s.c.id, workspaceId: s.c.workspaceId }, res);
          s.changed += applied.changed;
          const n = res.recipients.length;
          s.skip += n;
          const pageSize = res.pagination.limit > 0 ? Math.min(res.pagination.limit, limit) : limit;
          const total = res.pagination.total;
          const hasMore = res.pagination.hasMore;
          s.finished =
            n === 0 ||
            hasMore === false ||
            (hasMore == null && (n < pageSize || (typeof total === "number" && s.skip >= total)));
        } catch (e) {
          s.failed = true;
          this.log.warn(`campaign ${s.c.id} recipient sweep failed: ${(e as Error).message}`);
        }
      }
      open = open.filter((s) => !s.finished && !s.failed);
    }
    // SP-13: multi-broadcast campaigns are saved per broadcast, then recounted once.
    const multi = new Map<string, { c: SweepCampaign; recount: boolean }>();
    for (const s of state) {
      if (s.pages === 0) continue;
      try {
        // R3: a pass that saw fewer rows than were sent (e.g. a silent page
        // cap) does not count as complete; it restarts and the aggregates stay.
        const covered = s.finished && s.skip >= s.u.expected;
        if (s.finished) this.passEndedAt.set(s.u.key, Date.now());
        if (s.u.partition) {
          const at = covered ? new Date() : null;
          await this.prisma.campaignBroadcast.update({
            where: { id: s.u.partition.id },
            data: s.finished ? { recipientSyncSkip: 0, ...(at ? { recipientsSyncedAt: at } : {}) } : { recipientSyncSkip: s.skip },
          });
          if (at) s.u.partition.recipientsSyncedAt = at;
          const m = multi.get(s.c.id) ?? { c: s.c, recount: false };
          m.recount ||= s.finished || s.changed > 0;
          multi.set(s.c.id, m);
          continue;
        }
        await this.prisma.campaign.update({
          where: { id: s.c.id },
          data: s.finished
            ? { recipientSyncSkip: 0, ...(covered ? { recipientsSyncedAt: new Date() } : {}) }
            : { recipientSyncSkip: s.skip },
        });
        if (s.finished || s.changed > 0) {
          const firstPassDone = covered || !!s.c.recipientsSyncedAt;
          await this.tracker.recountCampaign(s.c.id, { floor: !firstPassDone });
        }
      } catch (e) {
        this.log.warn(`campaign ${s.c.id} recipient sweep save failed: ${(e as Error).message}`);
      }
    }
    for (const { c, recount } of multi.values()) {
      try {
        // The campaign's first pass is done once every broadcast's pass covered its rows.
        const parts = units.filter((u) => u.c.id === c.id && u.partition).map((u) => u.partition!);
        const firstPassDone = !!c.recipientsSyncedAt || (parts.length > 0 && parts.every((p) => !!p.recipientsSyncedAt));
        if (firstPassDone && !c.recipientsSyncedAt) {
          await this.prisma.campaign.update({ where: { id: c.id }, data: { recipientsSyncedAt: new Date() } });
        }
        if (recount) await this.tracker.recountCampaign(c.id, { floor: !firstPassDone });
      } catch (e) {
        this.log.warn(`campaign ${c.id} recipient sweep save failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * SP-13: what the sweep pages. A campaign launched before SP-13 (no
   * `sendTransport`) is one unit keyed by its id, exactly as before. A
   * multi-broadcast campaign is one unit per sent broadcast, each with its
   * own `recipientSyncSkip` and pass state, matching rows by
   * `(campaignId, phone)` like the legacy path. One query loads them all.
   */
  private async sweepUnits(campaigns: SweepCampaign[]): Promise<SweepUnit[]> {
    const legacy = (c: SweepCampaign): SweepUnit => ({
      key: c.id,
      c,
      broadcastId: c.zernioBroadcastId!,
      skip: c.recipientSyncSkip ?? 0,
      syncedAt: c.recipientsSyncedAt ?? null,
      expected: c.recipients ?? 0,
      partition: null,
    });
    const multiIds = campaigns.filter((c) => c.sendTransport === "broadcast").map((c) => c.id);
    if (multiIds.length === 0) return campaigns.map(legacy);
    const parts = (await this.prisma.campaignBroadcast.findMany({
      where: { campaignId: { in: multiIds }, zernioBroadcastId: { not: null }, stage: { in: SWEPT_STAGES } },
      select: { id: true, campaignId: true, zernioBroadcastId: true, recipientSyncSkip: true, recipientsSyncedAt: true, recipientCount: true },
    })) as SweepPartition[];
    return campaigns.flatMap((c) => {
      const mine = c.sendTransport === "broadcast" ? parts.filter((p) => p.campaignId === c.id) : [];
      if (mine.length === 0) return [legacy(c)];
      return mine.map((p) => ({
        key: `bc:${p.id}`,
        c,
        broadcastId: p.zernioBroadcastId,
        skip: p.recipientSyncSkip ?? 0,
        syncedAt: p.recipientsSyncedAt ?? null,
        expected: p.recipientCount ?? 0,
        partition: p,
      }));
    });
  }

  /**
   * Status (and, while `useAggregates`, counters) from Zernio: one broadcast
   * for a legacy campaign; every sent broadcast of an SP-13 campaign,
   * combined by `aggregateBroadcastStatus`.
   */
  private async statsFor(c: {
    id: string;
    workspaceId: string;
    zernioBroadcastId: string | null;
    status?: string | null;
    sendTransport?: string | null;
    recipientTracking?: boolean | null;
    recipientsSyncedAt?: Date | null;
  }) {
    const aggregates = this.useAggregates(c);
    // Final review (m1): an SP-13 campaign's status is only moved by a sync
    // while it is active, and only forward; terminal states belong to the
    // runner and the cancel paths. A legacy campaign keeps Zernio's status.
    const statusFrom = (zernioStatus: string): { status?: CampaignStatusValue } => {
      const next = campaignStatusFor(zernioStatus);
      if (!c.sendTransport) return { status: next };
      return forwardStatus(c.status ?? null, next) ? { status: next } : {};
    };
    if (c.sendTransport === "broadcast") {
      const parts = (await this.prisma.campaignBroadcast.findMany({
        where: { workspaceId: c.workspaceId, campaignId: c.id, zernioBroadcastId: { not: null }, stage: { in: SWEPT_STAGES } },
        select: { zernioBroadcastId: true },
      })) as Array<{ zernioBroadcastId: string }>;
      if (parts.length > 0) {
        const stats = [];
        for (const p of parts) {
          // m3: up to 25 reads per campaign per tick share the launch budget.
          stats.push(await budgeted(this.budget.campaign, () => this.zernio.getBroadcast(p.zernioBroadcastId)));
        }
        const b = aggregateBroadcastStatus(stats);
        return this.prisma.campaign.update({
          where: { id: c.id },
          data: {
            ...statusFrom(b.status),
            ...(aggregates ? { sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed } : {}),
            statsSyncedAt: new Date(),
          },
        });
      }
    }
    return this.applyStats(c.id, c.zernioBroadcastId!, aggregates, statusFrom);
  }

  /**
   * Zernio's broadcast status (through `statusFrom`); its aggregate counters
   * only when `aggregates` (see `useAggregates`). The read is budgeted
   * (final review, R19).
   */
  private async applyStats(
    id: string,
    broadcastId: string,
    aggregates: boolean,
    statusFrom: (zernioStatus: string) => { status?: CampaignStatusValue },
  ) {
    const b = await budgeted(this.budget.campaign, () => this.zernio.getBroadcast(broadcastId));
    return this.prisma.campaign.update({
      where: { id },
      data: {
        ...statusFrom(b.status),
        ...(aggregates ? { sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed } : {}),
        statsSyncedAt: new Date(),
      },
    });
  }
}

type CampaignStatusValue = ReturnType<typeof campaignStatusFor>;

/** The campaign fields the cancel rule reads. */
export interface CancellableShape {
  id: string;
  status: string;
  sendTransport?: string | null;
  zernioBroadcastId?: string | null;
}

/** Only an SP-13 broadcast campaign in one of these states needs its partitions read. */
function needsLiveCheck(c: CancellableShape): boolean {
  return c.sendTransport === "broadcast" && ["scheduled", "running", "failed", "cancelled"].includes(c.status);
}

/**
 * Whether `cancel` has something to stop, given whether the campaign has a
 * partition our records call sent or scheduled (`live`): a launching
 * campaign; a waiting scheduled direct one; a scheduled or running one with
 * a broadcast; a failed or cancelled SP-13 campaign with a live partition
 * (fix rounds 1 I1 and 2 n2). Shared by GET :id and GET /campaigns.
 */
export function cancellableRule(c: CancellableShape, live: boolean): boolean {
  if (c.status === "launching") return true;
  if (c.sendTransport === "direct") return c.status === "scheduled";
  const active = ["scheduled", "running"].includes(c.status);
  if (needsLiveCheck(c)) return live || (active && !!c.zernioBroadcastId);
  return !!c.zernioBroadcastId && active;
}

const STATUS_RANK: Record<string, number> = { scheduled: 1, running: 2, completed: 3, failed: 3, cancelled: 3 };

/**
 * Final review (m1): a sync may move an SP-13 campaign only while it is
 * scheduled or running, and only forward (scheduled, then running, then a
 * terminal state). Never out of a terminal state, never back, never to draft.
 */
export function forwardStatus(current: string | null, next: string): boolean {
  if (current !== "scheduled" && current !== "running") return false;
  const to = STATUS_RANK[next];
  return to !== undefined && to >= STATUS_RANK[current];
}
