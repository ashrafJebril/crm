import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PaymentLockService } from "../billing/payment-lock.service";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioBroadcastVariable, ZernioClient } from "../integrations/zernio.client";
import {
  buildRecipients,
  campaignStatusFor,
  chunk,
  estimateMetaCost,
  templatePlaceholderCount,
  totalSkipped,
} from "./campaign-audience";

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly zernio: ZernioClient,
    private readonly paymentLock: PaymentLockService,
  ) {}

  private audience(workspaceId: string, segmentId: string | null | undefined) {
    return this.prisma.contact.findMany({
      where: segmentId ? { workspaceId, segmentMembers: { some: { segmentId } } } : { workspaceId },
      select: { name: true, phone: true, lifecycle: true },
    });
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

    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { zernioProfileId: true } });
    const integration = await this.prisma.integration.findFirst({
      where: { workspaceId, provider: "zernio", platform: "whatsapp" },
      select: { pageId: true },
    });
    if (!workspace?.zernioProfileId || !integration?.pageId) {
      throw new BadRequestException("Connect WhatsApp in Settings → Integrations before sending a campaign.");
    }
    const profileId = workspace.zernioProfileId;
    const accountId = integration.pageId;

    const { recipients, skipped } = buildRecipients(await this.audience(workspaceId, campaign.segmentId));
    if (recipients.length === 0) {
      throw new BadRequestException("No one in this audience has a WhatsApp number with a country code.");
    }

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
    return this.applyStats(campaign.id, campaign.zernioBroadcastId);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async syncActive(): Promise<void> {
    const active = await this.prisma.campaign.findMany({
      where: { zernioBroadcastId: { not: null }, status: { in: ["scheduled", "running"] } },
      select: { id: true, workspaceId: true, zernioBroadcastId: true },
    });
    for (const c of active) {
      try {
        await this.applyStats(c.id, c.zernioBroadcastId!);
      } catch (e) {
        this.log.warn(`campaign ${c.id} stats sync failed: ${(e as Error).message}`);
      }
    }
  }

  private async applyStats(id: string, broadcastId: string) {
    const b = await this.zernio.getBroadcast(broadcastId);
    return this.prisma.campaign.update({
      where: { id },
      data: {
        status: campaignStatusFor(b.status),
        sent: b.sent,
        delivered: b.delivered,
        read: b.read,
        failed: b.failed,
        statsSyncedAt: new Date(),
      },
    });
  }
}
