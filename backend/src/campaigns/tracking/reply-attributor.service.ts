import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { normalizePhone } from "../campaign-audience";
import { markRepliedPatch } from "./recipient-status";
import { RecipientTrackerService } from "./recipient-tracker.service";

export interface InboundReplyInput {
  workspaceId: string;
  channelId: string | null | undefined;
  contactId: string | null | undefined;
  /** Any shape; normalized with normalizePhone. */
  phone: string | null | undefined;
  text: string | null | undefined;
  buttonPayload?: string | null;
  /** Our Message.id of the inbound message (deep link into the thread). */
  inboundMessageId: string | null | undefined;
  at: Date;
}

/** A reply counts for 72 h after the send; exactly 72 h is inside. */
export const REPLY_WINDOW_MS = 72 * 3_600_000;
/**
 * Campaign prefilter slack: a row's sentAt can trail its campaign's
 * launch/schedule by the broadcast's sending time. The exact window is
 * applied per row in TS.
 */
const SEND_SLACK_MS = 24 * 3_600_000;

/**
 * SP-12 reply attribution (ruling 6). Candidates are rows on the same
 * channel, matching the sender's normalized phone or contact id, not
 * skipped, whose effective send time `COALESCE(sentAt, scheduledAt,
 * launchedAt)` is at most 72 h before the reply. The single latest candidate
 * (greatest effective time, then greatest id) is marked replied, only if it
 * has no reply yet: first reply wins, and there is no fallback to an older
 * campaign. Called from the Zernio, Meta and InboundSink inbound paths, and
 * never throws into them.
 */
@Injectable()
export class CampaignReplyAttributor {
  private readonly log = new Logger(CampaignReplyAttributor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: RecipientTrackerService,
  ) {}

  async onInbound(input: InboundReplyInput): Promise<{ recipientId: string; campaignId: string } | null> {
    try {
      return await this.attribute(input);
    } catch (e) {
      this.log.warn(`campaign reply attribution failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async attribute(input: InboundReplyInput): Promise<{ recipientId: string; campaignId: string } | null> {
    const at = input.at;
    if (!input.workspaceId || !input.channelId || !(at instanceof Date) || !Number.isFinite(at.getTime())) return null;
    const phone = normalizePhone(input.phone ?? null);
    const contactId = input.contactId || null;
    if (!phone && !contactId) return null;

    const since = new Date(at.getTime() - REPLY_WINDOW_MS - SEND_SLACK_MS);
    const campaigns = await this.prisma.campaign.findMany({
      where: {
        workspaceId: input.workspaceId,
        recipientTracking: true,
        launchedAt: { not: null, lte: at },
        OR: [{ launchedAt: { gte: since } }, { scheduledAt: { gte: since } }],
      },
      select: { id: true, launchedAt: true, scheduledAt: true },
    });
    if (campaigns.length === 0) return null;
    const byId = new Map(campaigns.map((c) => [c.id, c]));

    const who: Array<{ phone: string } | { contactId: string }> = [];
    if (phone) who.push({ phone });
    if (contactId) who.push({ contactId });
    const rows = await this.prisma.campaignRecipient.findMany({
      where: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        campaignId: { in: [...byId.keys()] },
        status: { not: "skipped" },
        OR: who,
      },
      select: { id: true, campaignId: true, status: true, sentAt: true, repliedAt: true },
    });

    let best: { row: (typeof rows)[number]; eff: number } | null = null;
    for (const row of rows) {
      const c = byId.get(row.campaignId);
      const effDate = row.sentAt ?? c?.scheduledAt ?? c?.launchedAt ?? null;
      if (!effDate) continue;
      const eff = effDate.getTime();
      if (eff > at.getTime() || at.getTime() - eff > REPLY_WINDOW_MS) continue;
      if (!best || eff > best.eff || (eff === best.eff && row.id > best.row.id)) best = { row, eff };
    }
    if (!best) return null;

    const patch = markRepliedPatch(best.row, {
      at,
      text: input.text,
      buttonPayload: input.buttonPayload,
      inboundMessageId: input.inboundMessageId,
    });
    if (!patch) return null; // the latest campaign already has its reply

    const res = await this.prisma.campaignRecipient.updateMany({
      where: { id: best.row.id, workspaceId: input.workspaceId, repliedAt: null, status: { not: "skipped" } },
      data: patch,
    });
    if (res.count !== 1) return null;
    // Fix M2: a cheap increment on the inbound path; the sweep's recount
    // reconciles every counter on its next tick.
    await this.prisma.campaign.update({ where: { id: best.row.campaignId }, data: { replied: { increment: 1 } } });
    return { recipientId: best.row.id, campaignId: best.row.campaignId };
  }
}
