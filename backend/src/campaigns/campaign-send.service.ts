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

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Rows per Zernio recipients page. 100 until the Task 4 probe shows the real maximum (ruling 1). */
export const recipientPageSize = () => positiveInt(process.env.ZERNIO_RECIPIENT_PAGE, 100);
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
   * round-trips (ruling 10). A draft that an interrupted earlier attempt
   * left rows on is cleared first: nothing was sent for it (no broadcast id).
   */
  private async writeRecipientRows(
    workspaceId: string,
    campaign: { id: string; recipientTracking?: boolean | null },
    channelId: string | null,
    recipients: ReturnType<typeof buildRecipients>["recipients"],
    skippedRows: ReturnType<typeof buildRecipients>["skippedRows"],
  ): Promise<void> {
    const campaignId = campaign.id;
    if (campaign.recipientTracking) {
      await this.prisma.campaignRecipient.deleteMany({ where: { workspaceId, campaignId } });
    }
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

  /** Pull one campaign's latest counters from Zernio. */
  async refresh(workspaceId: string, id: string) {
    const campaign = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (!campaign.zernioBroadcastId) return campaign;
    return this.applyStats(campaign.id, campaign.zernioBroadcastId, campaign.recipientTracking === true);
  }

  /**
   * Every 5 minutes:
   * - active campaigns (scheduled/running) get Zernio's status (and, when
   *   untracked, its aggregate counters);
   * - tracked campaigns, active or finished within 72 h of launch, get a
   *   bounded recipient sweep (SP-12).
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncActive(): Promise<void> {
    const tailSince = new Date(Date.now() - RECIPIENT_SWEEP_TAIL_MS);
    const rows = await this.prisma.campaign.findMany({
      where: {
        zernioBroadcastId: { not: null },
        OR: [
          { status: { in: ACTIVE } },
          { recipientTracking: true, status: { in: FINISHED }, launchedAt: { gte: tailSince } },
        ],
      },
      select: {
        id: true,
        workspaceId: true,
        zernioBroadcastId: true,
        status: true,
        recipientTracking: true,
        recipientSyncSkip: true,
      },
    });
    for (const c of rows) {
      const tracked = c.recipientTracking === true;
      if (!FINISHED.includes(c.status as string)) {
        try {
          await this.applyStats(c.id, c.zernioBroadcastId!, tracked);
        } catch (e) {
          this.log.warn(`campaign ${c.id} stats sync failed: ${(e as Error).message}`);
        }
      }
      if (tracked) {
        try {
          await this.sweepRecipients(c);
        } catch (e) {
          this.log.warn(`campaign ${c.id} recipient sweep failed: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * SP-12 pull sweep (the source of truth, ruling 1): up to
   * RECIPIENT_SYNC_MAX_PAGES pages of ZERNIO_RECIPIENT_PAGE rows from
   * `recipientSyncSkip`. The offset is saved even when a page fails; when
   * Zernio says `hasMore: false` it resets to 0, `recipientsSyncedAt` is set
   * and the counters are recounted from rows.
   */
  private async sweepRecipients(c: {
    id: string;
    workspaceId: string;
    zernioBroadcastId: string | null;
    recipientSyncSkip?: number | null;
  }): Promise<void> {
    if (!c.zernioBroadcastId) return;
    const limit = recipientPageSize();
    const maxPages = recipientSyncMaxPages();
    let skip = c.recipientSyncSkip ?? 0;
    let finished = false;
    try {
      for (let page = 0; page < maxPages; page++) {
        const res = await this.zernio.listBroadcastRecipients(c.zernioBroadcastId, { skip, limit });
        await this.tracker.applyBroadcastPage({ id: c.id, workspaceId: c.workspaceId }, res);
        skip += res.recipients.length;
        if (!res.pagination.hasMore || res.recipients.length === 0) {
          finished = true;
          break;
        }
      }
    } finally {
      await this.prisma.campaign.update({
        where: { id: c.id },
        data: finished ? { recipientSyncSkip: 0, recipientsSyncedAt: new Date() } : { recipientSyncSkip: skip },
      });
    }
    if (finished) await this.tracker.recountCampaign(c.id);
  }

  /**
   * Zernio's broadcast status always; its aggregate counters only for
   * untracked (pre-SP-12) campaigns. Tracked campaigns take their counters
   * from their rows (ruling 5).
   */
  private async applyStats(id: string, broadcastId: string, tracked = false) {
    const b = await this.zernio.getBroadcast(broadcastId);
    return this.prisma.campaign.update({
      where: { id },
      data: {
        status: campaignStatusFor(b.status),
        ...(tracked ? {} : { sent: b.sent, delivered: b.delivered, read: b.read, failed: b.failed }),
        statsSyncedAt: new Date(),
      },
    });
  }
}
