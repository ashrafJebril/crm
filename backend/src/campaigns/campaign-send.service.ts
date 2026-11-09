import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioBroadcastVariable, ZernioClient } from "../integrations/zernio.client";
import { campaignSender, campaignSenderAccountId } from "../channels/default-channel";
import { RecipientTrackerService } from "./tracking/recipient-tracker.service";
import { SKIP_CODES } from "./tracking/failure-codes";
import {
  buildRecipients,
  campaignStatusFor,
  chunk,
  estimateMetaCost,
  templatePlaceholderCount,
  totalSkipped,
} from "./campaign-audience";

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

export interface LaunchInput {
  mode: "now" | "schedule";
  scheduledAt?: string;
  variables: ZernioBroadcastVariable[];
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    private readonly paymentLock: PaymentLockService,
    // From CampaignTrackingModule; hand-built specs get one over the same Prisma.
    @Optional() tracker?: RecipientTrackerService,
  ) {
    this.tracker = tracker ?? new RecipientTrackerService(prisma);
  }

  private audience(workspaceId: string, segmentId: string | null | undefined) {
    return this.prisma.contact.findMany({
      where: segmentId ? { workspaceId, segmentMembers: { some: { segmentId } } } : { workspaceId },
      select: { id: true, name: true, phone: true, lifecycle: true, marketingOptOut: true },
    });
  }

  /** Create/update guard for `senderChannelId` (null/undefined = default). */
  async validateSender(workspaceId: string, senderChannelId: string | null | undefined): Promise<void> {
    if (senderChannelId) await campaignSenderAccountId(this.prisma, workspaceId, senderChannelId);
  }

  /** Who a segment (or everyone) would reach, and roughly what Meta will charge. */
  async preview(workspaceId: string, segmentId: string | null) {
    const contacts = await this.audience(workspaceId, segmentId);
    const { recipients, skipped } = buildRecipients(contacts);
    return {
      total: contacts.length,
      reachable: recipients.length,
      skipped,
      estimate: estimateMetaCost(recipients.map((r) => r.phone)),
    };
  }

  async launch(workspaceId: string, id: string, input: LaunchInput) {
    if (await this.paymentLock.isLocked(workspaceId)) {
      throw new BadRequestException("Sending is paused until the overdue payment for this workspace is settled.");
    }
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (campaign.status !== "draft" || campaign.zernioBroadcastId) {
      throw new BadRequestException("This campaign has already been launched.");
    }

    let scheduledAt: Date | null = null;
    if (input.mode === "schedule") {
      scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
      if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException("Pick a date and time in the future.");
      }
    }

    const template = campaign.templateId
      ? await this.prisma.template.findFirst({ where: { id: campaign.templateId, workspaceId } })
      : null;
    if (!template || template.status !== "approved") {
      throw new BadRequestException("Pick a WhatsApp template that Meta has approved.");
    }
    const needed = templatePlaceholderCount(template.body);
    if (input.variables.length !== needed) {
      throw new BadRequestException(`This template needs ${needed} variables; ${input.variables.length} were given.`);
    }

    // SP-19: the chosen sender (an active Zernio WhatsApp channel, else 400
    // channels.sender_invalid) or, when none was chosen, the default one.
    // SP-12: with its channel id, recorded on every recipient row.
    const sender = await campaignSender(this.prisma, workspaceId, campaign.senderChannelId);
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { zernioProfileId: true } });
    if (!workspace?.zernioProfileId || !sender) {
      throw new BadRequestException("Connect a WhatsApp number in Channels before sending a campaign.");
    }
    const profileId = workspace.zernioProfileId;
    const accountId = sender.accountId;

    const { recipients, skipped, skippedRows } = buildRecipients(await this.audience(workspaceId, campaign.segmentId));
    if (recipients.length === 0) {
      throw new BadRequestException("No one in this audience has a WhatsApp number with a country code.");
    }

    await this.writeRecipientRows(workspaceId, campaign, sender.channelId, recipients, skippedRows);

    // Import first so Zernio knows each person's name for {{n}} = name.
    for (const batch of chunk(recipients, 1000)) {
      await this.zernio.bulkCreateContacts(
        profileId,
        accountId,
        batch.map((r) => ({ name: r.name, platformIdentifier: r.phone })),
      );
    }

    const broadcastId = await this.zernio.createWhatsAppBroadcast({
      profileId,
      accountId,
      name: campaign.name,
      template: { name: template.name, language: template.lang },
      variables: input.variables,
    });

    try {
      for (const batch of chunk(recipients.map((r) => r.phone), 100)) {
        await this.zernio.addBroadcastRecipients(broadcastId, batch);
      }
      if (scheduledAt) await this.zernio.scheduleBroadcast(broadcastId, scheduledAt.toISOString());
      else await this.zernio.sendBroadcast(broadcastId);
    } catch (e) {
      await this.prisma.campaign.update({
        where: { id },
        data: { status: "failed", zernioBroadcastId: broadcastId, lastError: (e as Error).message },
      });
      throw e;
    }

    return this.prisma.campaign.update({
      where: { id },
      data: {
        status: scheduledAt ? "scheduled" : "running",
        zernioBroadcastId: broadcastId,
        scheduledAt,
        launchedAt: new Date(),
        recipients: recipients.length,
        skipped: totalSkipped(skipped),
        variableMapping: input.variables as unknown as Prisma.InputJsonValue,
        lastError: null,
      },
    });
  }

  /**
   * SP-12: one row per reachable phone (`queued`) and per opted-out or
   * phoneless member (`skipped`), written BEFORE Zernio is called so a crash
   * mid-launch leaves an honest "not sent" record. Chunked createMany of
   * 1000 with skipDuplicates on (campaignId, phone); no per-recipient
   * round-trips (ruling 10). Any rows an interrupted earlier attempt left on
   * the draft are cleared first: nothing was sent for it (no broadcast id).
   */
  private async writeRecipientRows(
    workspaceId: string,
    campaign: { id: string; recipientTracking?: boolean | null },
    channelId: string | null,
    recipients: ReturnType<typeof buildRecipients>["recipients"],
    skippedRows: ReturnType<typeof buildRecipients>["skippedRows"],
  ): Promise<void> {
    const campaignId = campaign.id;
    // Fix M1: always, since a launch that died mid-write leaves rows while
    // recipientTracking is still false. One indexed statement.
    await this.prisma.campaignRecipient.deleteMany({ where: { workspaceId, campaignId } });
    const queued = recipients.map((r) => ({
      workspaceId,
      campaignId,
      contactId: r.contactId ?? null,
      channelId,
      phone: r.phone,
      contactName: r.name,
      status: "queued",
    }));
    for (const data of chunk(queued, RECIPIENT_WRITE_CHUNK)) {
      await this.prisma.campaignRecipient.createMany({ data, skipDuplicates: true });
    }
    const left = skippedRows.map((r) => ({
      workspaceId,
      campaignId,
      contactId: r.contactId ?? null,
      channelId,
      phone: r.phone,
      contactName: r.name.trim() || null,
      status: "skipped",
      failureCode: SKIP_CODES[r.reason],
    }));
    for (const data of chunk(left, RECIPIENT_WRITE_CHUNK)) {
      await this.prisma.campaignRecipient.createMany({ data, skipDuplicates: true });
    }
    await this.prisma.campaign.update({ where: { id: campaignId }, data: { recipientTracking: true } });
  }

  async cancel(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (!campaign.zernioBroadcastId || !["scheduled", "running"].includes(campaign.status)) {
      throw new BadRequestException("This campaign is not sending, so there is nothing to cancel.");
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
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (!campaign.zernioBroadcastId) return campaign;
    const updated = await this.applyStats(campaign.id, campaign.zernioBroadcastId, this.useAggregates(campaign));
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
        },
      });
      for (const c of rows) {
        if (FINISHED.includes(c.status as string)) continue;
        try {
          await this.applyStats(c.id, c.zernioBroadcastId!, this.useAggregates(c));
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
  private async sweepAll(
    campaigns: Array<{
      id: string;
      workspaceId: string;
      zernioBroadcastId: string | null;
      status?: string | null;
      recipients?: number | null;
      recipientSyncSkip?: number | null;
      recipientsSyncedAt?: Date | null;
    }>,
    opts: { maxPages?: number; force?: boolean } = {},
  ): Promise<void> {
    const limit = recipientPageSize();
    let budget = opts.maxPages ?? recipientSyncMaxPages();
    const now = Date.now();
    const tailDue = (c: (typeof campaigns)[number]) => {
      if (opts.force || !FINISHED.includes(c.status as string)) return true;
      const lastEnd = Math.max(c.recipientsSyncedAt?.getTime() ?? 0, this.passEndedAt.get(c.id) ?? 0);
      return now - lastEnd >= RECIPIENT_TAIL_INTERVAL_MS;
    };
    const synced = (c: (typeof campaigns)[number]) => c.recipientsSyncedAt?.getTime() ?? -1;
    const state = campaigns
      .filter((c) => c.zernioBroadcastId && tailDue(c))
      .sort(
        (a, b) =>
          (this.lastPagedAt.get(a.id) ?? 0) - (this.lastPagedAt.get(b.id) ?? 0) ||
          synced(a) - synced(b) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((c) => ({ c, skip: c.recipientSyncSkip ?? 0, finished: false, failed: false, changed: 0, pages: 0 }));
    let open = state;
    while (budget > 0 && open.length > 0) {
      for (const s of open) {
        if (budget <= 0) break;
        budget--;
        s.pages++;
        this.lastPagedAt.set(s.c.id, ++this.pageSeq);
        try {
          const res = await this.zernio.listBroadcastRecipients(s.c.zernioBroadcastId!, { skip: s.skip, limit });
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
    for (const s of state) {
      if (s.pages === 0) continue;
      try {
        // R3: a pass that saw fewer rows than were sent (e.g. a silent page
        // cap) does not count as complete; it restarts and the aggregates stay.
        const covered = s.finished && s.skip >= (s.c.recipients ?? 0);
        if (s.finished) this.passEndedAt.set(s.c.id, Date.now());
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
  }

  /**
   * Zernio's broadcast status always; its aggregate counters only when
   * `aggregates` (see `useAggregates`).
   */
  private async applyStats(id: string, broadcastId: string, aggregates = true) {
    const b = await this.zernio.getBroadcast(broadcastId);
    return this.prisma.campaign.update({
      where: { id },
      data: {
        status: campaignStatusFor(b.status),
        ...(aggregates ? { sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed } : {}),
        statsSyncedAt: new Date(),
      },
    });
  }
}
