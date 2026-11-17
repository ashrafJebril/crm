import { Injectable, Logger, Optional } from "@nestjs/common";
import { UsageService } from "../../billing/usage.service";
import { PrismaService } from "../../prisma/prisma.service";
import type { ZernioBroadcastRecipient } from "../../integrations/zernio.client";
import { normalizePhone } from "../campaign-audience";
import { providerFailure } from "./failure-codes";
import {
  MergedState,
  mergeRecipientEvent,
  mergeRecipientEvents,
  RecipientEvent,
  RecipientEventKind,
} from "./recipient-status";

export interface ProviderStatusInput {
  workspaceId: string;
  /** Every id the event carries (Zernio's id, Meta's wamid); empty values are dropped. */
  ids: Array<string | null | undefined>;
  kind: RecipientEventKind;
  at: Date;
  failureCode?: string | null;
  failureReason?: string | null;
}

export interface StampByPhoneInput {
  workspaceId: string;
  channelId: string;
  phone: string | null | undefined;
  messageId: string | null | undefined;
  at: Date;
}

/** Campaigns still worth stamping by phone (ruling 2): running, or launched in the last 24 h. */
export const STAMP_WINDOW_MS = 24 * 3_600_000;

/** Fields a status write reads back for the merge and the compare-and-set. */
const STATE_SELECT = {
  id: true,
  status: true,
  updatedAt: true,
  messageId: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failureCode: true,
  failureReason: true,
} as const;

type StateRow = MergedState & { id: string; updatedAt: Date };

const parseDate = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** One Zernio recipient row → the events it implies (pending implies none). */
export function eventsForZernioRecipient(r: ZernioBroadcastRecipient): RecipientEvent[] {
  const messageId = r.messageId ?? null;
  const sent: RecipientEvent = { kind: "sent", at: parseDate(r.sentAt), messageId };
  switch (r.status) {
    case "sent":
      return [sent];
    case "delivered":
      return [sent, { kind: "delivered", at: parseDate(r.deliveredAt), messageId }];
    case "read": {
      const out: RecipientEvent[] = [sent];
      if (r.deliveredAt) out.push({ kind: "delivered", at: parseDate(r.deliveredAt), messageId });
      out.push({ kind: "read", at: parseDate(r.readAt), messageId });
      return out;
    }
    case "failed": {
      const out: RecipientEvent[] = r.sentAt ? [sent] : [];
      out.push({ kind: "failed", at: null, messageId, ...providerFailure(r.error, r.errorCode, r.errorExplanation) });
      return out;
    }
    default:
      return [];
  }
}

/**
 * SP-12: writes per-recipient delivery state. Every write goes through
 * `mergeRecipientEvent` and is a compare-and-set on the row's previous
 * `status` and `updatedAt`, so concurrent writers (webhooks, the pull sweep,
 * reply attribution) never overwrite each other blindly. Its only
 * dependency is the global PrismaService.
 */
@Injectable()
export class RecipientTrackerService {
  private readonly log = new Logger(RecipientTrackerService.name);

  constructor(
    private readonly prisma: PrismaService,
    // SP-28: campaign messages are metered when a recipient is first seen sent.
    @Optional() private readonly usage?: UsageService,
  ) {}

  /**
   * A provider status event (Zernio `message.*` webhook or a Meta status).
   * Matches rows by `messageId` within the channel's workspace only. Returns
   * the number of rows changed; unknown ids return 0 with no write. Never
   * throws: a webhook must still answer 200.
   */
  async applyProviderStatus(input: ProviderStatusInput): Promise<number> {
    const ids = [...new Set(input.ids.filter((v): v is string => typeof v === "string" && v !== ""))];
    if (ids.length === 0 || !input.workspaceId) return 0;
    const event: RecipientEvent = {
      kind: input.kind,
      at: input.at,
      failureCode: input.failureCode ?? null,
      failureReason: input.failureReason ?? null,
    };
    try {
      const rows = (await this.prisma.campaignRecipient.findMany({
        where: { workspaceId: input.workspaceId, messageId: { in: ids } },
        select: STATE_SELECT,
      })) as StateRow[];
      let changed = 0;
      for (const row of rows) {
        if (await this.casApply(input.workspaceId, row, event)) changed++;
      }
      return changed;
    } catch (e) {
      this.log.warn(`recipient status (${input.kind}) not applied: ${(e as Error).message}`);
      return 0;
    }
  }

  /** Merge one event into one row with compare-and-set, retrying once on a lost race. */
  private async casApply(workspaceId: string, row: StateRow, event: RecipientEvent): Promise<boolean> {
    let current: StateRow | null = row;
    for (let attempt = 0; attempt < 2 && current; attempt++) {
      const { next, changed } = mergeRecipientEvent(current, event);
      if (!changed) return false;
      const res = await this.prisma.campaignRecipient.updateMany({
        where: { id: current.id, workspaceId, status: current.status, updatedAt: current.updatedAt },
        data: {
          status: next.status,
          messageId: next.messageId,
          sentAt: next.sentAt,
          deliveredAt: next.deliveredAt,
          readAt: next.readAt,
          failureCode: next.failureCode,
          failureReason: next.failureReason,
        },
      });
      if (res.count > 0) return true;
      current = (await this.prisma.campaignRecipient.findFirst({
        where: { id: current.id, workspaceId },
        select: STATE_SELECT,
      })) as StateRow | null;
    }
    return false;
  }

  /**
   * Ruling 2: a Zernio `message.sent` that matched no Message row may stamp
   * the queued recipient with the same channel and phone, so later
   * delivered/read webhooks match within seconds. Only when exactly one
   * queued, unstamped row of a sending campaign (running, or launched in the
   * last 24 h) matches; otherwise nothing, and the pull sweep fills it.
   * Never throws.
   */
  async stampByPhone(input: StampByPhoneInput): Promise<boolean> {
    const phone = normalizePhone(input.phone ?? null);
    if (!phone || !input.messageId || !input.channelId || !input.workspaceId) return false;
    try {
      const since = new Date(Date.now() - STAMP_WINDOW_MS);
      const campaigns = await this.prisma.campaign.findMany({
        where: {
          workspaceId: input.workspaceId,
          recipientTracking: true,
          status: { not: "draft" },
          OR: [{ status: "running" }, { launchedAt: { gte: since } }],
        },
        select: { id: true },
      });
      if (campaigns.length === 0) return false;
      const rows = await this.prisma.campaignRecipient.findMany({
        where: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          phone,
          status: "queued",
          messageId: null,
          campaignId: { in: campaigns.map((c) => c.id) },
        },
        select: STATE_SELECT,
        take: 2,
      });
      if (rows.length !== 1) return false;
      const row = rows[0] as StateRow;
      const { next } = mergeRecipientEvent(row, { kind: "sent", at: input.at, messageId: input.messageId });
      const res = await this.prisma.campaignRecipient.updateMany({
        where: { id: row.id, workspaceId: input.workspaceId, status: "queued", messageId: null, updatedAt: row.updatedAt },
        data: { status: next.status, messageId: next.messageId, sentAt: next.sentAt },
      });
      if (res.count === 1) {
        await this.usage?.record(input.workspaceId, { meter: "campaign_message", sourceKind: "campaign_recipient", sourceId: row.id });
      }
      return res.count === 1;
    } catch (e) {
      this.log.warn(`recipient phone stamp failed: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * One page of Zernio's per-recipient list for a campaign: matched by
   * `(campaignId, phone)` in one query, merged in TS, and the changed rows
   * written in one compare-and-set statement. Rows that lost a race are
   * picked up on the next pass; Zernio rows with no matching phone are
   * ignored. Throws on a DB error (the sweep logs it per campaign).
   */
  async applyBroadcastPage(
    campaign: { id: string; workspaceId: string },
    page: { recipients: ZernioBroadcastRecipient[] },
  ): Promise<{ matched: number; changed: number }> {
    const byPhone = new Map<string, RecipientEvent[]>();
    for (const r of page.recipients) {
      const phone = normalizePhone(r.platformIdentifier);
      if (!phone) continue;
      const events = eventsForZernioRecipient(r);
      if (events.length === 0) continue;
      byPhone.set(phone, [...(byPhone.get(phone) ?? []), ...events]);
    }
    if (byPhone.size === 0) return { matched: 0, changed: 0 };

    const rows = await this.prisma.campaignRecipient.findMany({
      where: { workspaceId: campaign.workspaceId, campaignId: campaign.id, phone: { in: [...byPhone.keys()] } },
      select: { ...STATE_SELECT, phone: true },
    });
    if (rows.length < byPhone.size) {
      this.log.debug(`campaign ${campaign.id}: ${byPhone.size - rows.length} Zernio recipients match no row`);
    }
    const changes: Array<MergedState & { id: string; prevStatus: string; prevUpdatedAt: Date }> = [];
    for (const row of rows as Array<StateRow & { phone: string | null }>) {
      const { next, changed } = mergeRecipientEvents(row, byPhone.get(row.phone ?? "") ?? []);
      if (changed) changes.push({ ...next, id: row.id, prevStatus: row.status, prevUpdatedAt: row.updatedAt });
    }
    if (changes.length === 0) return { matched: rows.length, changed: 0 };

    const json = JSON.stringify(
      changes.map((c) => ({
        id: c.id,
        prevStatus: c.prevStatus,
        prevUpdatedAt: c.prevUpdatedAt.toISOString(),
        status: c.status,
        messageId: c.messageId,
        sentAt: c.sentAt?.toISOString() ?? null,
        deliveredAt: c.deliveredAt?.toISOString() ?? null,
        readAt: c.readAt?.toISOString() ?? null,
        failureCode: c.failureCode,
        failureReason: c.failureReason,
      })),
    );
    // Timestamps are UTC ISO strings; casting to timestamp(3) drops the "Z",
    // which matches how Prisma stores DateTime (UTC wall clock).
    const changed = await this.prisma.$executeRaw`
      UPDATE "CampaignRecipient" AS r SET
        "status" = v."status",
        "messageId" = v."messageId",
        "sentAt" = v."sentAt",
        "deliveredAt" = v."deliveredAt",
        "readAt" = v."readAt",
        "failureCode" = v."failureCode",
        "failureReason" = v."failureReason",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${json}::jsonb) AS v(
        "id" text, "prevStatus" text, "prevUpdatedAt" timestamp(3), "status" text, "messageId" text,
        "sentAt" timestamp(3), "deliveredAt" timestamp(3), "readAt" timestamp(3),
        "failureCode" text, "failureReason" text
      )
      WHERE r."id" = v."id"
        AND r."workspaceId" = ${campaign.workspaceId}
        AND r."campaignId" = ${campaign.id}
        AND r."status" = v."prevStatus"
        AND r."updatedAt" = v."prevUpdatedAt"`;
    // SP-28: every recipient Zernio reports as sent is metered once (idempotent per row).
    await this.usage?.recordMany(
      campaign.workspaceId,
      "campaign_message",
      "campaign_recipient",
      changes.filter((c) => c.sentAt !== null && c.sentAt !== undefined).map((c) => c.id),
    );
    return { matched: rows.length, changed: Number(changed) };
  }

  /**
   * With `floor`, each counter only rises (used before the first full pass).
   * Ruling 5: a tracked campaign's counters come from its rows (one
   * groupBy over the (campaignId, status, id) index).
   *   sent = sent + delivered + read + replied; delivered = delivered + read + replied;
   *   read = read + replied; failed = failed; replied = replied.
   */
  async recountCampaign(campaignId: string, opts: { floor?: boolean } = {}): Promise<void> {
    const groups = (await this.prisma.campaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId },
      _count: { _all: true },
    })) as Array<{ status: string; _count: { _all: number } }>;
    const n = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const replied = n("replied");
    const read = n("read") + replied;
    const delivered = n("delivered") + read;
    let data = { sent: n("sent") + delivered, delivered, read, failed: n("failed"), replied };
    if (opts.floor) {
      // Fix I1: before the first full sweep pass the rows are incomplete, so
      // they may only raise the counters Zernio's aggregates already set.
      const cur = await this.prisma.campaign.findFirst({
        where: { id: campaignId },
        select: { sent: true, delivered: true, read: true, failed: true, replied: true },
      });
      if (cur) {
        data = {
          sent: Math.max(data.sent, cur.sent ?? 0),
          delivered: Math.max(data.delivered, cur.delivered ?? 0),
          read: Math.max(data.read, cur.read ?? 0),
          failed: Math.max(data.failed, cur.failed ?? 0),
          replied: Math.max(data.replied, cur.replied ?? 0),
        };
      }
    }
    // Fix round 2 (R4): `replied` is also incremented by the attributor on
    // the inbound path, possibly between our groupBy and this write. Writing
    // it as GREATEST(current, rows) in one statement cannot lose such an
    // increment; replies are terminal and increments are one per first
    // reply, so `current` never exceeds the true count.
    const { replied: repliedRows, ...rest } = data;
    await this.prisma.campaign.update({ where: { id: campaignId }, data: rest });
    await this.prisma.$executeRaw`UPDATE "Campaign" SET "replied" = GREATEST("replied", ${repliedRows}::int) WHERE "id" = ${campaignId}`;
  }
}
