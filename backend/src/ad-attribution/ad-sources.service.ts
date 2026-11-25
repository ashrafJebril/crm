import { Injectable, Optional } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionService } from "../permissions/permission.service";
import type { Viewer } from "../permissions/visibility";
import { adsError } from "./ad-errors";
import { resolveDayRange } from "./ad-range";

export const AD_FILTER_MAX = 500;
export const AD_CONVERSATIONS_MAX = 100;
export const AD_CONVERSATIONS_DEFAULT = 50;

/** `GET /ad-sources` item (the inbox Ad source filter). */
export interface AdFilterItem {
  id: string;
  /** `adName ?? headline ?? sourceId`. */
  label: string;
  sourceType: string;
  lastReferredAt: Date | null;
}

/** `GET /ad-sources/:id/conversations` item (one touch of the ad). */
export interface AdConversationItem {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  channelId: string | null;
  referredAt: Date;
  firstTouch: boolean;
  status: string;
  assigneeId: string | null;
}

export interface AdConversationsQuery {
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string | number;
}

/** Opaque keyset cursor over `(referredAt desc, id desc)`. */
export function encodeCursor(row: { referredAt: Date; id: string }): string {
  return Buffer.from(`${row.referredAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const at = new Date(iso);
    if (!id || Number.isNaN(at.getTime())) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** The timezone day ranges use (ruling 8): the active ad account's, else the workspace's. */
export async function attributionTimeZone(
  prisma: Pick<PrismaService, "metaAdsConnection" | "workspace">,
  workspaceId: string,
): Promise<string | null> {
  const conn = await prisma.metaAdsConnection.findUnique({
    where: { workspaceId },
    select: { status: true, timezone: true },
  });
  if (conn?.status === "active" && conn.timezone) return conn.timezone;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  return ws?.timezone ?? null;
}

@Injectable()
export class AdSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    // Global PermissionsModule in the app; unit specs may omit it.
    @Optional() private readonly perm?: PermissionService,
  ) {}

  /** Ads that started at least one conversation, newest first (≤ 500). No spend. */
  async listForFilter(workspaceId: string): Promise<{ items: AdFilterItem[] }> {
    const rows = await this.prisma.adSource.findMany({
      where: { workspaceId, lastReferredAt: { not: null } },
      orderBy: [{ lastReferredAt: "desc" }, { id: "desc" }],
      take: AD_FILTER_MAX,
      select: { id: true, sourceId: true, sourceType: true, headline: true, adName: true, lastReferredAt: true },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        label: r.adName ?? r.headline ?? r.sourceId,
        sourceType: r.sourceType,
        lastReferredAt: r.lastReferredAt,
      })),
    };
  }

  /**
   * The ad's touches (one per referral-bearing message) in the range, ANDed
   * with the viewer's conversation scope. A foreign or missing ad is 404
   * `ads.not_found`. Cursor `(referredAt desc, id desc)`, `limit` ≤ 100.
   */
  async conversations(
    workspaceId: string,
    id: string,
    viewer: Viewer | undefined,
    q: AdConversationsQuery = {},
  ): Promise<{ items: AdConversationItem[]; nextCursor: string | null }> {
    const ad = await this.prisma.adSource.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!ad) throw adsError("ads.not_found");

    const range = resolveDayRange(q, await attributionTimeZone(this.prisma, workspaceId));
    const limitRaw = q.limit === undefined || q.limit === "" ? AD_CONVERSATIONS_DEFAULT : Number(q.limit);
    if (!Number.isInteger(limitRaw) || limitRaw < 1) throw adsError("ads.range_invalid", { param: "limit" });
    const limit = Math.min(limitRaw, AD_CONVERSATIONS_MAX);
    const cursor = q.cursor ? decodeCursor(String(q.cursor)) : null;
    if (q.cursor && !cursor) throw adsError("ads.range_invalid", { param: "cursor" });

    const scope = this.perm ? await this.perm.conversationScope(workspaceId, viewer) : {};
    const and: Prisma.AdReferralWhereInput[] = [
      { workspaceId, adSourceId: ad.id, referredAt: { gte: range.start, lt: range.end } },
    ];
    if (Object.keys(scope).length > 0) and.push({ conversation: { is: { workspaceId, ...scope } } });
    if (cursor) {
      and.push({ OR: [{ referredAt: { lt: cursor.at } }, { referredAt: cursor.at, id: { lt: cursor.id } }] });
    }

    const rows = await this.prisma.adReferral.findMany({
      where: { AND: and },
      orderBy: [{ referredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        conversationId: true,
        contactId: true,
        channelId: true,
        referredAt: true,
        firstTouch: true,
        conversation: { select: { status: true, assigneeId: true, channelId: true } },
      },
    });
    const page = rows.slice(0, limit);
    const contactIds = [...new Set(page.map((r) => r.contactId))];
    const contacts = contactIds.length
      ? await this.prisma.contact.findMany({ where: { workspaceId, id: { in: contactIds } }, select: { id: true, name: true } })
      : [];
    const names = new Map(contacts.map((c) => [c.id, c.name]));
    return {
      items: page.map((r) => ({
        conversationId: r.conversationId,
        contactId: r.contactId,
        contactName: names.get(r.contactId) ?? null,
        channelId: r.conversation.channelId ?? r.channelId,
        referredAt: r.referredAt,
        firstTouch: r.firstTouch,
        status: r.conversation.status,
        assigneeId: r.conversation.assigneeId,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }
}
