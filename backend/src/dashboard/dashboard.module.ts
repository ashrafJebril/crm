import { Controller, Get, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CurrentWorkspace } from "../common/current-workspace.decorator";

/**
 * Inclusive bounds for a "last N days ending today" window (UTC).
 * Returns 7 buckets keyed by ISO date (YYYY-MM-DD).
 */
function lastNDays(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function startOfDayUtc(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

interface DailyRow {
  day: string;       // ISO date (YYYY-MM-DD)
  total: number;
  human: number;
}

interface IntentRow {
  name: string;
  count: number;
  pct: number;
}

interface ActivityRow {
  id: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  preview: string;
  channel: string;
  from: string;       // "them" | "human"
  at: string;         // ISO timestamp
}

@Controller("dashboard")
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary(@CurrentWorkspace() workspaceId: string) {
    const since7 = startOfDayUtc(6);   // start of the 7-day window
    const since14 = startOfDayUtc(13); // for week-over-week deltas

    const [
      contacts,
      conversations,
      appointments,
      campaigns,
      templates,
      escalated,
      unreadAgg,
      runningCampaigns,
      // ── Time-windowed counts (for deltas)
      convThis7,
      convPrev7,
      // ── Daily timeseries (last 7 days)
      dailyRaw,
      // ── Intent breakdown
      intentRaw,
      // ── Recent activity (last 10 inbound/outbound messages)
      recentMessages,
    ] = await Promise.all([
      this.prisma.contact.count({ where: { workspaceId } }),
      this.prisma.conversation.count({ where: { workspaceId } }),
      this.prisma.appointment.count({ where: { workspaceId } }),
      this.prisma.campaign.count({ where: { workspaceId } }),
      this.prisma.template.count({ where: { workspaceId } }),
      this.prisma.conversation.count({ where: { workspaceId, escalated: true } }),
      this.prisma.conversation.aggregate({
        where: { workspaceId },
        _sum: { unread: true },
      }),
      this.prisma.campaign.findMany({
        where: { workspaceId, status: "running" },
        take: 3,
      }),
      this.prisma.conversation.count({
        where: { workspaceId, createdAt: { gte: since7 } },
      }),
      this.prisma.conversation.count({
        where: {
          workspaceId,
          createdAt: { gte: since14, lt: since7 },
        },
      }),
      this.prisma.$queryRaw<
        Array<{ day: string; total: bigint; human: bigint }>
      >`
        SELECT
          to_char(date_trunc('day', m."createdAt") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          COUNT(*)::bigint                                            AS total,
          COUNT(*) FILTER (WHERE m."from" = 'human')::bigint          AS human
        FROM "Message" m
        WHERE m."workspaceId" = ${workspaceId}
          AND m."createdAt" >= ${since7}
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ intent: string; count: bigint }>>`
        SELECT c."intent" AS intent, COUNT(*)::bigint AS count
        FROM "Conversation" c
        WHERE c."workspaceId" = ${workspaceId}
          AND c."intent" IS NOT NULL
          AND c."intent" <> ''
          AND c."intent" <> '—'
        GROUP BY c."intent"
        ORDER BY count DESC
        LIMIT 6
      `,
      this.prisma.message.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: {
          conversation: { include: { contact: true } },
        },
      }),
    ]);

    // Pad daily timeseries to a full 7-day window even when some days have
    // zero activity, so the chart doesn't shift around as data appears.
    const dailyMap = new Map<string, DailyRow>();
    for (const r of dailyRaw) {
      dailyMap.set(r.day, {
        day: r.day,
        total: Number(r.total),
        human: Number(r.human),
      });
    }
    const daily: DailyRow[] = lastNDays(7).map(
      (day) => dailyMap.get(day) ?? { day, total: 0, human: 0 },
    );

    // Intents: convert counts → percentages of the labelled set.
    const intentTotal = intentRaw.reduce(
      (s, r) => s + Number(r.count),
      0,
    );
    const topIntents: IntentRow[] = intentRaw.map((r) => {
      const count = Number(r.count);
      return {
        name: r.intent,
        count,
        pct: intentTotal > 0 ? Math.round((count / intentTotal) * 100) : 0,
      };
    });

    const recentActivity: ActivityRow[] = recentMessages.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      contactId: m.conversation.contactId,
      contactName: m.conversation.contact.name,
      preview: m.body.slice(0, 140),
      channel: m.conversation.channel,
      from: m.from,
      at: m.createdAt.toISOString(),
    }));

    // Week-over-week % delta for new conversations.
    const convDeltaPct =
      convPrev7 > 0
        ? Math.round(((convThis7 - convPrev7) / convPrev7) * 100)
        : convThis7 > 0
          ? 100
          : 0;

    return {
      counts: {
        contacts,
        conversations,
        appointments,
        campaigns,
        templates,
        escalated,
        unread: unreadAgg._sum.unread ?? 0,
      },
      runningCampaigns,
      daily,
      topIntents,
      recentActivity,
      deltas: {
        conversationsPct: convDeltaPct,
        conversationsThis7: convThis7,
        conversationsPrev7: convPrev7,
      },
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
