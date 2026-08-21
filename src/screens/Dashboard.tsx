import { memo, useMemo } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useRoute } from "@/router";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { AreaChart, Spark } from "@/components/charts";
import {
  IconArrowDown, IconArrowUp, IconBolt, IconCal, IconChev, IconChevDown, IconMore,
} from "@/icons";
import { useFetch } from "@/api/useFetch";
import { Skeleton } from "@/components/Skeleton";
import {
  ActivitySkeleton,
  CampaignsSkeleton,
  ChannelsSkeleton,
  ChartSkeleton,
  IntentsSkeleton,
  PipelineSkeleton,
} from "./dashboard/DashboardSkeletons";
import { CHANNEL_LABEL } from "@/lib/types";
import type {
  Campaign,
  Conversation,
  ConvChannel,
  TicketsDashboardSummary,
} from "@/lib/types";

interface DailyPoint {
  day: string;
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
  from: string; // "them" | "human"
  at: string;
}

const CHANNEL_ORDER: ConvChannel[] = [
  "whatsapp",
  "instagram",
  "facebook",
  "tiktok",
  "webchat",
];

const CHANNEL_FILL: Record<ConvChannel, string> = {
  whatsapp:  "#25D366",
  instagram: "linear-gradient(90deg, #F58529 0%, #DD2A7B 55%, #8134AF 100%)",
  facebook:  "#1877F2",
  tiktok:    "#000000",
  webchat:   "var(--info)",
};

const CHANNEL_DOT: Record<ConvChannel, string> = {
  whatsapp:  "#25D366",
  instagram: "linear-gradient(135deg, #F58529, #DD2A7B 55%, #8134AF)",
  facebook:  "#1877F2",
  tiktok:    "#000000",
  webchat:   "var(--info)",
};

interface DashboardSummary {
  counts: {
    contacts: number;
    conversations: number;
    appointments: number;
    campaigns: number;
    templates: number;
    escalated: number;
    unread: number;
  };
  runningCampaigns: Campaign[];
  daily: DailyPoint[];
  topIntents: IntentRow[];
  recentActivity: ActivityRow[];
  deltas: {
    conversationsPct: number;
    conversationsThis7: number;
    conversationsPrev7: number;
  };
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  delta: string;
  sub: string;
  spark?: number[];
  invert?: boolean;
  /** First-load placeholder: the tile keeps its shape but shows no number. */
  loading?: boolean;
}

function StatTile({ label, value, unit, delta, sub, spark, invert, loading }: StatTileProps) {
  const isEmpty = delta === null || delta === undefined || delta === "";
  const isDown = !isEmpty && delta.startsWith("-");
  const tone = isEmpty ? "muted" : isDown ? (invert ? "" : "down") : "";
  return (
    <div className="stat">
      <div className="label">
        {label}
        <span style={{ marginInlineStart: "auto" }}>
          <IconMore w={14} />
        </span>
      </div>
      <div className="value">
        {loading ? (
          <Skeleton h={26} w={96} style={{ margin: "3px 0" }} />
        ) : (
          <>
            {value}
            {unit && <span className="unit">{unit}</span>}
          </>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {!loading && !isEmpty && (
            <span className={`delta ${tone}`.trim()}>
              {isDown ? <IconArrowDown w={11} /> : <IconArrowUp w={11} />}
              {delta}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</span>
        </div>
        {loading
          ? <Skeleton h={24} w={80} />
          : spark && spark.length > 0 && <Spark values={spark} w={80} h={24} />}
      </div>
    </div>
  );
}

function DashboardImpl() {
  const { t } = useTweaks();
  const [, setRoute] = useRoute();
  const tx = makeTx(t.lang);
  const {
    data: summary,
    loading: summaryLoading,
    error: summaryError,
  } = useFetch<DashboardSummary>("/dashboard/summary");
  const { data: ticketsSummary, loading: ticketsLoading } =
    useFetch<TicketsDashboardSummary>("/tickets/dashboard/summary");
  const {
    data: conversations,
    loading: convLoading,
    error: convError,
  } = useFetch<Conversation[]>("/conversations");

  // `loading` is true for background refetches too (the lists poll), so gate
  // the placeholders on "still waiting for the FIRST response" — otherwise
  // every poll would blink the cards back to skeletons.
  const summaryPending = summaryLoading && !summary;
  const ticketsPending = ticketsLoading && !ticketsSummary;
  const convPending = convLoading && !conversations;

  const channelStats = useMemo(() => {
    const counts: Record<ConvChannel, number> = {
      whatsapp:  0,
      instagram: 0,
      facebook:  0,
      tiktok:    0,
      webchat:   0,
    };
    if (conversations) {
      for (const c of conversations) {
        if (c.channel in counts) counts[c.channel] += 1;
      }
    }
    const total = CHANNEL_ORDER.reduce((s, ch) => s + counts[ch], 0);
    const rows = CHANNEL_ORDER.map((ch) => {
      const count = counts[ch];
      const pct = total > 0 ? (count / total) * 100 : 0;
      return { channel: ch, count, pct };
    });
    return { counts, total, rows };
  }, [conversations]);

  const conversationsValue = summary
    ? summary.counts.conversations.toLocaleString()
    : "0";
  // Sparklines derived from the same 7-day timeseries.
  const totalSpark = (summary?.daily ?? []).map((d) => d.total);

  // Day-of-week labels lined up with summary.daily for the chart x-axis.
  const xLabels = (summary?.daily ?? []).map((d) => {
    const dt = new Date(d.day + "T00:00:00Z");
    return DAY_LABELS[dt.getUTCDay()] ?? "";
  });
  const aSeries = (summary?.daily ?? []).map((d) => d.total);
  const bSeries = (summary?.daily ?? []).map((d) => d.human);

  const conversationsDelta = summary
    ? `${summary.deltas.conversationsPct > 0 ? "+" : ""}${summary.deltas.conversationsPct}%`
    : "";

  const recentActivity = summary?.recentActivity ?? [];
  const topIntents = summary?.topIntents ?? [];

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Welcome back, Yara", "أهلاً يا يارا")}
        subtitle={tx(
          "Here's how Samemha's WhatsApp ran today",
          "إليك ما حدث على واتساب اليوم",
        )}
        actions={
          <>
            <button className="btn">
              <IconCal w={14} />
              {tx("Last 7 days", "آخر ٧ أيام")}
              <IconChevDown w={12} />
            </button>
            <button className="btn primary">
              <IconBolt w={14} />
              {tx("New campaign", "حملة جديدة")}
            </button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <StatTile
            label={tx("Conversations", "المحادثات")}
            value={conversationsValue}
            delta={conversationsDelta}
            sub={tx("vs prev 7d", "مقارنة بالأسبوع السابق")}
            spark={totalSpark}
            loading={summaryPending}
          />
          <StatTile
            label={tx("Unread", "غير مقروء")}
            value={summary?.counts.unread.toLocaleString() ?? "0"}
            delta=""
            sub={tx("Across all channels", "عبر جميع القنوات")}
            loading={summaryPending}
          />
          <StatTile
            label={tx("Pipeline value", "قيمة المبيعات")}
            value={
              ticketsSummary
                ? `${ticketsSummary.currency} ${ticketsSummary.openValue.toLocaleString()}`
                : "0"
            }
            delta=""
            sub={tx("Open tickets", "تذاكر مفتوحة")}
            loading={ticketsPending}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <h3>{tx("Conversations · last 7 days", "المحادثات · آخر ٧ أيام")}</h3>
                <div className="sub">{tx("Total vs assigned", "الإجمالي مقابل المعيّنة")}</div>
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 12 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--accent)" }} /> {tx("Total", "الإجمالي")}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--ink-3)" }} /> {tx("Assigned", "معيّنة")}
                </span>
              </div>
            </div>
            <div style={{ padding: "16px 16px 8px" }}>
              {summaryPending ? (
                <ChartSkeleton h={180} />
              ) : (
                <>
                  <AreaChart a={aSeries} b={bSeries} w={680} h={180} />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 4,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--ink-3)",
                    }}
                  >
                    {xLabels.map((d, i) => (
                      <span key={`${d}-${i}`}>{d}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <h3>{tx("Live activity", "النشاط المباشر")}</h3>
              <span className="badge accent">
                <span className="dot pulse" />
                {tx("streaming", "مباشر")}
              </span>
            </div>
            <div style={{ padding: "4px 6px 12px" }}>
              {summaryPending && <ActivitySkeleton />}
              {!summaryPending && recentActivity.length === 0 && (
                <div
                  className="mono muted"
                  style={{ padding: "12px 12px", fontSize: 11, opacity: 0.7 }}
                >
                  {tx("No recent activity yet.", "لا يوجد نشاط حديث.")}
                </div>
              )}
              {recentActivity.map((row) => {
                const isInbound = row.from === "them";
                const verb = isInbound
                  ? tx("messaged", "راسل")
                  : tx("replied to", "ردّ على");
                return (
                  <div
                    key={row.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                    }}
                  >
                    <Avatar name={row.contactName} color="270" size="sm" />
                    <div style={{ fontSize: 13, flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{row.contactName}</span>
                      <span style={{ color: "var(--ink-2)" }}> · {verb} </span>
                      <span
                        style={{
                          color: "var(--ink-3)",
                          display: "block",
                          fontSize: 11,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {row.preview}
                      </span>
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 11,
                        color: "var(--ink-3)",
                        flex: "0 0 auto",
                      }}
                    >
                      {relTime(row.at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Top intents", "أهم النوايا")}</h3>
              <span className="sub">{tx("all conversations", "كل المحادثات")}</span>
            </div>
            <div style={{ padding: 16 }}>
              {summaryPending ? (
                <IntentsSkeleton />
              ) : topIntents.length === 0 ? (
                <div
                  className="mono muted"
                  style={{ fontSize: 11, opacity: 0.7 }}
                >
                  {tx("No intents tagged yet.", "لم يُصنّف أي نية بعد.")}
                </div>
              ) : (
                topIntents.map((it, i) => (
                  <div key={it.name} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        marginBottom: 4,
                      }}
                    >
                      <span>{it.name}</span>
                      <span className="mono muted">
                        {it.count} · {it.pct}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: 5,
                        background: "var(--bg-2)",
                        borderRadius: 3,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${it.pct}%`,
                          height: "100%",
                          background: "var(--accent)",
                          opacity: 0.4 + i * 0.1,
                        }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Pipeline performance", "أداء خط المبيعات")}</h3>
              <span className="sub">{tx("all time", "كل الفترة")}</span>
            </div>
            <div style={{ padding: "12px 16px 16px" }}>
              {ticketsPending && <PipelineSkeleton />}
              {!ticketsPending && (() => {
                const won = ticketsSummary?.wonCount ?? 0;
                const lost = ticketsSummary?.lostCount ?? 0;
                const total = won + lost;
                const wonPct = total > 0 ? (won / total) * 100 : 0;
                const lostPct = total > 0 ? (lost / total) * 100 : 0;
                const winRate = ticketsSummary
                  ? Math.round(ticketsSummary.winRate * 100)
                  : 0;
                const avgClose = ticketsSummary
                  ? Math.round(ticketsSummary.avgCloseHours)
                  : 0;
                const openValueLabel = ticketsSummary
                  ? `${ticketsSummary.currency} ${ticketsSummary.openValue.toLocaleString()}`
                  : "—";
                return (
                  <>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 600,
                        letterSpacing: "-0.01em",
                        fontFamily: "var(--font-mono)",
                        lineHeight: 1.1,
                      }}
                    >
                      {winRate}%
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                      {won} {tx("won", "ربح")} · {lost} {tx("lost", "خسارة")}
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        display: "flex",
                        height: 10,
                        width: "100%",
                        borderRadius: 999,
                        overflow: "hidden",
                        background: "var(--bg-2)",
                      }}
                    >
                      {wonPct > 0 && (
                        <div
                          title={`${tx("Won", "ربح")} · ${won}`}
                          style={{ width: `${wonPct}%`, background: "var(--ok)" }}
                        />
                      )}
                      {lostPct > 0 && (
                        <div
                          title={`${tx("Lost", "خسارة")} · ${lost}`}
                          style={{ width: `${lostPct}%`, background: "var(--bad)" }}
                        />
                      )}
                    </div>
                    <div
                      style={{
                        marginTop: 12,
                        display: "grid",
                        gap: 4,
                        fontSize: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          color: "var(--ink-2)",
                        }}
                      >
                        <span>{tx("Avg close", "متوسط الإغلاق")}</span>
                        <span className="mono" style={{ color: "var(--ink-1)" }}>
                          {avgClose}h
                        </span>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          color: "var(--ink-2)",
                        }}
                      >
                        <span>{tx("Open", "مفتوح")}</span>
                        <span className="mono" style={{ color: "var(--ink-1)" }}>
                          {openValueLabel}
                        </span>
                      </div>
                    </div>
                  </>
                );
              })()}
              <button
                className="btn ghost sm"
                style={{ marginTop: 14, width: "100%", justifyContent: "center" }}
                onClick={() => setRoute("pipeline")}
              >
                {tx("Open pipeline", "افتح خط المبيعات")}
                <IconChev w={12} />
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Active campaigns", "الحملات النشطة")}</h3>
              <button className="btn ghost sm" onClick={() => setRoute("campaigns")}>
                {tx("All", "الكل")}
                <IconChev w={12} />
              </button>
            </div>
            <div style={{ padding: "4px 6px 12px" }}>
              {summaryPending ? (
                <CampaignsSkeleton />
              ) : summaryError ? (
                <div style={{ padding: 12, fontSize: 12, color: "var(--danger, #c33)" }}>
                  {summaryError}
                </div>
              ) : (
                (summary?.runningCampaigns ?? []).slice(0, 3).map((c) => {
                  const recipients = c.recipients || 0;
                  const readPct = recipients
                    ? Math.round((c.read / recipients) * 100)
                    : 0;
                  const deliveredPct = recipients
                    ? (c.delivered / recipients) * 100
                    : 0;
                  const readMinusReplied = recipients
                    ? ((c.read - c.replied) / recipients) * 100
                    : 0;
                  return (
                    <div
                      key={c.id}
                      style={{ padding: "10px 12px", borderRadius: 8, marginBottom: 4 }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{c.name}</span>
                        <Badge kind="ok" dot>running</Badge>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginTop: 4,
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {recipients.toLocaleString()} · {readPct}% read · {c.replied} replies
                      </div>
                      <div
                        style={{
                          height: 4,
                          background: "var(--bg-2)",
                          borderRadius: 2,
                          marginTop: 8,
                          overflow: "hidden",
                          display: "flex",
                        }}
                      >
                        <div
                          style={{
                            width: `${deliveredPct}%`,
                            background: "var(--accent)",
                            opacity: 0.6,
                          }}
                        />
                        <div
                          style={{
                            width: `${readMinusReplied}%`,
                            background: "var(--accent)",
                            opacity: 0.3,
                          }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <div>
                <h3>
                  {tx("Messages by channel", "الرسائل حسب القناة")}
                </h3>
                <div className="sub">
                  {tx("Inbound volume across platforms", "الحجم الوارد عبر القنوات")}
                </div>
              </div>
            </div>
            <div style={{ padding: "12px 16px 16px" }}>
              {convPending ? (
                <ChannelsSkeleton />
              ) : (
                <>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                    fontFamily: "var(--font-mono)",
                    lineHeight: 1.1,
                  }}
                >
                  {channelStats.total.toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
                  {tx("Total messages", "إجمالي الرسائل")}
                </div>

                {convError ? (
                  <div
                    style={{
                      marginTop: 14,
                      fontSize: 12,
                      color: "var(--bad)",
                    }}
                  >
                    {convError}
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      height: 10,
                      width: "100%",
                      borderRadius: 999,
                      overflow: "hidden",
                      background: "var(--bg-2)",
                    }}
                  >
                    {channelStats.rows.map((r) =>
                      r.pct > 0 ? (
                        <div
                          key={r.channel}
                          title={`${CHANNEL_LABEL[r.channel]} · ${r.count}`}
                          style={{
                            width: `${r.pct}%`,
                            background: CHANNEL_FILL[r.channel],
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                )}

                <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
                  {channelStats.rows.map((r) => (
                    <div
                      key={r.channel}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        fontSize: 12,
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: CHANNEL_DOT[r.channel],
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: "var(--ink-1)", flex: 1 }}>
                        {CHANNEL_LABEL[r.channel]}
                      </span>
                      <span
                        className="mono"
                        style={{ color: "var(--ink-2)", fontSize: 11 }}
                      >
                        {r.count.toLocaleString()}
                      </span>
                      <span
                        className="mono muted"
                        style={{
                          fontSize: 11,
                          width: 44,
                          textAlign: "end",
                        }}
                      >
                        {r.pct.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Dashboard = memo(DashboardImpl);
export default Dashboard;
