import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { csvCell } from "../contacts/contacts-export.service";
import type { ExportSink, PreparedExport } from "../common/csv-stream";
import { campaignError } from "./campaign-errors";
import { EXPORT_HEADERS, failureLabel, statusLabel } from "./campaign-export-labels";
import {
  EXPORT_IDS_CAP,
  EXPORT_LANGS,
  RECIPIENTS_PAGE_DEFAULT,
  RECIPIENTS_PAGE_MAX,
  type ExportLang,
} from "./campaign-report.dto";
import { decodeCursor, encodeCursor } from "./recipient-cursor";
import { isShortTitle } from "./tracking/failure-codes";
import { RECIPIENT_STATUSES, type RecipientStatus } from "./tracking/recipient-status";

/** Keyset batch size of the streamed export. */
export const EXPORT_BATCH = 1000;
const BOM = "﻿";

export interface RecipientDto {
  id: string;
  contactId: string | null;
  name: string | null;
  phone: string | null;
  status: RecipientStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  replyText: string | null;
  buttonPayload: string | null;
  replyMessageId: string | null;
  failureCode: string | null;
  /** `failureReason` only when it is a short one-line title (isShortTitle), else null. */
  failureTitle: string | null;
  channel: { id: string; displayName: string; phoneNumber: string | null } | null;
}

export interface RecipientsPage {
  tracked: boolean;
  items: RecipientDto[];
  nextCursor: string | null;
}

export interface CampaignInsights {
  tracked: boolean;
  total: number;
  counts: Record<RecipientStatus, number>;
  funnel: { targeted: number; sent: number; delivered: number; read: number; replied: number };
  readTiming: { withinHour: number; oneToSix: number; sixToDay: number; afterDay: number };
  replies: { payload: string | null; label: string | null; count: number }[];
  failures: { code: string; title: string | null; count: number }[];
  unrecorded: number;
  recipientsSyncedAt: string | null;
  statsSyncedAt: string | null;
}

type Row = {
  id: string;
  contactId: string | null;
  channelId: string | null;
  phone: string | null;
  contactName: string | null;
  status: string;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  repliedAt?: Date | null;
  replyText?: string | null;
  buttonPayload?: string | null;
  replyMessageId?: string | null;
  failureCode?: string | null;
  failureReason?: string | null;
};

type ChannelRef = { id: string; displayName: string; phoneNumber: string | null };

const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : null);
const isStatus = (s: unknown): s is RecipientStatus =>
  typeof s === "string" && (RECIPIENT_STATUSES as readonly string[]).includes(s);
const emptyCounts = () =>
  Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0])) as Record<RecipientStatus, number>;
const distinct = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** ASCII-only slug for Content-Disposition (an Arabic name falls back to the id). */
export function asciiSlug(s: string, max = 40): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * SP-12 read side: keyset-paged recipients, insights and the streamed CSV.
 * Every query is scoped `workspaceId + campaignId` (raw SQL included: the
 * tenancy extension does not cover it), and is served by the T1 indexes:
 * - `CampaignRecipient_campaignId_status_id_idx` (campaignId, status, id):
 *   filtered pages and export batches, counts by status, and the read
 *   timing / replies / failures aggregates (status IN / = filters).
 * - `CampaignRecipient_campaignId_id_idx` (campaignId, id): unfiltered pages
 *   and export batches.
 */
@Injectable()
export class CampaignReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** The campaign, scoped by workspace. A foreign or unknown id is 404, never 403. */
  async loadCampaign(workspaceId: string, id: string) {
    const c = await this.prisma.campaign.findFirst({ where: { id, workspaceId } });
    if (!c) throw campaignError("campaigns.not_found");
    return c;
  }

  async recipients(
    workspaceId: string,
    campaignId: string,
    q: { status?: RecipientStatus; cursor?: string; limit?: number },
  ): Promise<RecipientsPage> {
    const campaign = await this.loadCampaign(workspaceId, campaignId);
    const status = q.status === undefined || q.status === null ? undefined : q.status;
    if (status !== undefined && !isStatus(status)) throw campaignError("campaigns.invalid_status");
    const limit = q.limit ?? RECIPIENTS_PAGE_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > RECIPIENTS_PAGE_MAX) {
      throw campaignError("campaigns.invalid_limit");
    }
    const after = decodeCursor(q.cursor, status ?? null);
    if (!campaign.recipientTracking) return { tracked: false, items: [], nextCursor: null };

    // Keyset: ids strictly increase, so no row is ever returned twice even
    // when a row changes status between pages.
    const rows = (await this.prisma.campaignRecipient.findMany({
      where: {
        workspaceId,
        campaignId,
        ...(status !== undefined ? { status } : {}),
        ...(after !== null ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: limit + 1,
    })) as Row[];
    const page = rows.slice(0, limit);
    const { names, channels } = await this.lookups(workspaceId, page);
    return {
      tracked: true,
      items: page.map((r) => this.toDto(r, names, channels)),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].id, status ?? null) : null,
    };
  }

  /** Current contact names and sending channels for one page: one query each, workspace-scoped. */
  private async lookups(workspaceId: string, rows: Row[]) {
    const contactIds = distinct(rows.map((r) => r.contactId));
    const channelIds = distinct(rows.map((r) => r.channelId));
    const [contacts, chans] = await Promise.all([
      contactIds.length
        ? this.prisma.contact.findMany({ where: { workspaceId, id: { in: contactIds } }, select: { id: true, name: true } })
        : Promise.resolve([] as { id: string; name: string }[]),
      channelIds.length
        ? this.prisma.channel.findMany({
            where: { workspaceId, id: { in: channelIds } },
            select: { id: true, displayName: true, phoneNumber: true },
          })
        : Promise.resolve([] as ChannelRef[]),
    ]);
    return {
      names: new Map(contacts.map((c) => [c.id, c.name])),
      channels: new Map((chans as ChannelRef[]).map((c) => [c.id, c])),
    };
  }

  private toDto(r: Row, names: Map<string, string>, channels: Map<string, ChannelRef>): RecipientDto {
    const current = r.contactId ? names.get(r.contactId) : undefined;
    const ch = r.channelId ? channels.get(r.channelId) : undefined;
    return {
      id: r.id,
      contactId: r.contactId ?? null,
      name: current && current.trim() ? current : (r.contactName ?? null),
      phone: r.phone ?? null,
      status: r.status as RecipientStatus,
      sentAt: iso(r.sentAt),
      deliveredAt: iso(r.deliveredAt),
      readAt: iso(r.readAt),
      repliedAt: iso(r.repliedAt),
      replyText: r.replyText ?? null,
      buttonPayload: r.buttonPayload ?? null,
      replyMessageId: r.replyMessageId ?? null,
      failureCode: r.failureCode ?? null,
      failureTitle: isShortTitle(r.failureReason) ? r.failureReason!.trim() : null,
      channel: ch ? { id: ch.id, displayName: ch.displayName, phoneNumber: ch.phoneNumber ?? null } : null,
    };
  }

  async insights(workspaceId: string, campaignId: string): Promise<CampaignInsights> {
    const c = await this.loadCampaign(workspaceId, campaignId);
    const synced = { recipientsSyncedAt: iso(c.recipientsSyncedAt), statsSyncedAt: iso(c.statsSyncedAt) };
    const readTiming = { withinHour: 0, oneToSix: 0, sixToDay: 0, afterDay: 0 };
    if (!c.recipientTracking) {
      // Historical campaign: aggregate counters only (ruling 3).
      return {
        tracked: false,
        total: 0,
        counts: emptyCounts(),
        funnel: {
          targeted: c.recipients ?? 0,
          sent: (c.sent ?? 0) + (c.failed ?? 0),
          delivered: c.delivered ?? 0,
          read: c.read ?? 0,
          replied: c.replied ?? 0,
        },
        readTiming,
        replies: [],
        failures: [],
        unrecorded: 0,
        ...synced,
      };
    }

    const [groups, timing, replyRows, failureRows] = await Promise.all([
      // Index-only GROUP BY on (campaignId, status, id).
      this.prisma.campaignRecipient.groupBy({
        by: ["status"],
        where: { workspaceId, campaignId },
        _count: { _all: true },
      }) as unknown as Promise<{ status: string; _count: { _all: number } }[]>,
      // A read stamped before its send (clock skew) is a negative interval: first bucket.
      this.prisma.$queryRaw<{ withinHour: number; oneToSix: number; sixToDay: number; afterDay: number }[]>`
        SELECT
          count(*) FILTER (WHERE "readAt" - "sentAt" < interval '1 hour')::int AS "withinHour",
          count(*) FILTER (WHERE "readAt" - "sentAt" >= interval '1 hour' AND "readAt" - "sentAt" < interval '6 hours')::int AS "oneToSix",
          count(*) FILTER (WHERE "readAt" - "sentAt" >= interval '6 hours' AND "readAt" - "sentAt" < interval '24 hours')::int AS "sixToDay",
          count(*) FILTER (WHERE "readAt" - "sentAt" >= interval '24 hours')::int AS "afterDay"
        FROM "CampaignRecipient"
        WHERE "workspaceId" = ${workspaceId} AND "campaignId" = ${campaignId}
          AND "status" IN ('read', 'replied') AND "sentAt" IS NOT NULL AND "readAt" IS NOT NULL
      `,
      this.prisma.$queryRaw<{ payload: string | null; label: string | null; count: number }[]>`
        SELECT "buttonPayload" AS payload,
          (array_agg("replyText" ORDER BY "repliedAt" DESC NULLS LAST, "id" DESC))[1] AS label,
          count(*)::int AS count
        FROM "CampaignRecipient"
        WHERE "workspaceId" = ${workspaceId} AND "campaignId" = ${campaignId} AND "status" = 'replied'
        GROUP BY "buttonPayload"
      `,
      this.prisma.$queryRaw<{ code: string | null; reason: string | null; count: number }[]>`
        SELECT "failureCode" AS code,
          (array_agg("failureReason" ORDER BY "updatedAt" DESC, "id" DESC) FILTER (WHERE "failureReason" IS NOT NULL))[1] AS reason,
          count(*)::int AS count
        FROM "CampaignRecipient"
        WHERE "workspaceId" = ${workspaceId} AND "campaignId" = ${campaignId} AND "status" IN ('failed', 'skipped')
        GROUP BY "failureCode"
      `,
    ]);

    const counts = emptyCounts();
    for (const g of groups) if (isStatus(g.status)) counts[g.status] = Number(g._count._all);
    const total = RECIPIENT_STATUSES.reduce((s, k) => s + counts[k], 0);
    // One outcome per row; the funnel sets (plan, Task 2).
    const replied = counts.replied;
    const read = counts.read + replied;
    const delivered = counts.delivered + read;
    const funnel = {
      targeted: total - counts.skipped,
      sent: counts.sent + delivered + counts.failed,
      delivered,
      read,
      replied,
    };

    const t = timing[0];
    if (t) {
      readTiming.withinHour = Number(t.withinHour ?? 0);
      readTiming.oneToSix = Number(t.oneToSix ?? 0);
      readTiming.sixToDay = Number(t.sixToDay ?? 0);
      readTiming.afterDay = Number(t.afterDay ?? 0);
    }

    // Largest first; typed replies (no payload) last.
    const replies = replyRows
      .map((r) => ({
        payload: r.payload ?? null,
        label: r.payload === null || r.payload === undefined ? null : (r.label ?? null),
        count: Number(r.count),
      }))
      .sort((a, b) => {
        if ((a.payload === null) !== (b.payload === null)) return a.payload === null ? 1 : -1;
        return b.count - a.count || String(a.payload).localeCompare(String(b.payload));
      });

    let unrecorded = 0;
    const failures: CampaignInsights["failures"] = [];
    for (const f of failureRows) {
      if (f.code === null || f.code === undefined || f.code === "") {
        unrecorded += Number(f.count);
        continue;
      }
      failures.push({ code: f.code, title: isShortTitle(f.reason) ? f.reason!.trim() : null, count: Number(f.count) });
    }
    failures.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    return { tracked: true, total, counts, funnel, readTiming, replies, failures, unrecorded, ...synced };
  }

  /**
   * Validates and resolves everything that can fail BEFORE any byte is
   * written, so errors are ordinary JSON responses. The rows stream in
   * keyset batches of 1000 on (campaignId[, status], id).
   */
  async prepareExport(
    workspaceId: string,
    campaignId: string,
    opts: { status?: RecipientStatus; ids?: string[]; lang?: ExportLang },
  ): Promise<PreparedExport> {
    const campaign = await this.loadCampaign(workspaceId, campaignId);
    const status = opts.status ?? undefined;
    if (status !== undefined && !isStatus(status)) throw campaignError("campaigns.invalid_status");
    if (opts.ids && opts.ids.length > EXPORT_IDS_CAP) {
      throw campaignError("campaigns.ids_too_many", { limit: EXPORT_IDS_CAP });
    }
    let ids = opts.ids ? distinct(opts.ids.map((x) => (typeof x === "string" ? x.trim() : ""))) : undefined;
    if (ids && !ids.length) ids = undefined;

    let lang: ExportLang;
    if (opts.lang && (EXPORT_LANGS as readonly string[]).includes(opts.lang)) lang = opts.lang;
    else {
      const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { lang: true } });
      lang = ws?.lang === "ar" ? "ar" : "en";
    }

    const slug = asciiSlug(campaign.name ?? "") || campaign.id.replace(/[^A-Za-z0-9_-]/g, "") || "export";
    const scope = ids ? "selected" : (status ?? "all");
    const filename = `campaign-${slug}-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    const header = EXPORT_HEADERS[lang].map(csvCell).join(",") + "\r\n";
    const tracked = campaign.recipientTracking;

    const run = async (sink: ExportSink) => {
      await sink.write(BOM + header);
      let rows = 0;
      let last: string | null = null;
      while (tracked && !sink.aborted()) {
        const idFilter: { in?: string[]; gt?: string } = {};
        if (ids) idFilter.in = ids;
        if (last !== null) idFilter.gt = last;
        const batch = (await this.prisma.campaignRecipient.findMany({
          where: {
            workspaceId,
            campaignId,
            ...(status !== undefined ? { status } : {}),
            ...(ids || last !== null ? { id: idFilter } : {}),
          },
          orderBy: { id: "asc" },
          take: EXPORT_BATCH,
        })) as Row[];
        if (!batch.length) break;
        const { names, channels } = await this.lookups(workspaceId, batch);
        let chunk = "";
        for (const r of batch) {
          const d = this.toDto(r, names, channels);
          const ch = d.channel;
          const sending = ch ? (ch.phoneNumber ? `${ch.displayName} (${ch.phoneNumber})` : ch.displayName) : "";
          chunk +=
            [
              d.name ?? "",
              d.phone ?? "",
              statusLabel(d.status, lang),
              d.sentAt ?? "",
              d.deliveredAt ?? "",
              d.readAt ?? "",
              d.repliedAt ?? "",
              d.replyText ?? "",
              d.buttonPayload ?? "",
              d.failureCode ?? "",
              failureLabel(r.failureCode ?? null, r.failureReason ?? null, lang),
              sending,
            ]
              .map(csvCell)
              .join(",") + "\r\n";
        }
        rows += batch.length;
        await sink.write(chunk);
        if (batch.length < EXPORT_BATCH) break;
        last = batch[batch.length - 1].id;
      }
      return { rows };
    };
    return { filename, run };
  }
}
