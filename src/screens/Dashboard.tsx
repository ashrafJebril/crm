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
import { AGENTS, findAgent } from "@/data/agents";
import { DAILY, INTENTS } from "@/data/analytics";
import { useFetch } from "@/api/useFetch";
import { CHANNEL_LABEL } from "@/lib/types";
import type {
  Campaign,
  Conversation,
  ConvChannel,
  TicketsDashboardSummary,
} from "@/lib/types";

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
    aiHandled: number;
    escalated: number;
    unread: number;
  };
  aiResolutionPct: number;
  runningCampaigns: Campaign[];
}

interface StatTileProps {
  label: string;
  value: string;
  unit?: string;
  delta: string;
  sub: string;
  spark?: number[];
  invert?: boolean;
}

function StatTile({ label, value, unit, delta, sub, spark, invert }: StatTileProps) {
  const isDown = delta.startsWith("-");
  const tone = isDown ? (invert ? "" : "down") : "";
  return (
    <div className="stat">
      <div className="label">
        {label}
        <span style={{ marginInlineStart: "auto" }}>
          <IconMore w={14} />
        </span>
      </div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span className={`delta ${tone}`.trim()}>
            {isDown ? <IconArrowDown w={11} /> : <IconArrowUp w={11} />}
            {delta}
          </span>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</span>
        </div>
        {spark && <Spark values={spark} w={80} h={24} />}
      </div>
    </div>
  );
}

const ACTIVITY_KEYS = ["a1", "a2", "a3", "a4", "a5", "a6"] as const;

function DashboardImpl() {
  const { t } = useTweaks();
  const [, setRoute] = useRoute();
  const tx = makeTx(t.lang);
  const { data: summary, loading: summaryLoading, error: summaryError } =
    useFetch<DashboardSummary>("/dashboard/summary");
  const { data: ticketsSummary } =
    useFetch<TicketsDashboardSummary>("/tickets/dashboard/summary");
  const {
    data: conversations,
    loading: convLoading,
    error: convError,
  } = useFetch<Conversation[]>("/conversations");

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
    : summaryLoading
      ? "0"
      : "0";
  const aiResolutionValue = summary
    ? `${summary.aiResolutionPct}`
    : summaryLoading
      ? "0"
      : "0";

  const activity = [
    { who: "Luna",  role: "ai" as const,    what: tx("booked viewing for", "حجزت معاينة لـ"),    to: "Reem Al-Qahtani", t: "just now" },
    { who: "Atlas", role: "ai" as const,    what: tx("answered order status for", "رد على حالة طلب لـ"), to: "Fatima Boutros", t: "1m" },
    { who: "Lina",  role: "human" as const, what: tx("took over from", "تولّت من"),               to: "Atlas → James W.", t: "3m" },
    { who: "Nova",  role: "ai" as const,    what: tx("qualified lead", "أهّل عميلاً محتملاً"),    to: "Sven Lindgren",   t: "8m" },
    { who: "Atlas", role: "ai" as const,    what: tx("escalated reschedule", "صعّد إعادة جدولة"), to: "Aisha Rahman",    t: "14m" },
    { who: "Luna",  role: "ai" as const,    what: tx("sent floor plan to", "أرسلت مخططًا إلى"),  to: "Hugo Martín",     t: "22m" },
  ];

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
            delta="+12.4%"
            sub={tx("vs prev 7d", "مقارنة بالأسبوع السابق")}
            spark={DAILY.conversations}
          />
          <StatTile
            label={tx("AI resolution", "حل بالذكاء")}
            value={aiResolutionValue}
            unit="%"
            delta="+4.1pp"
            sub={tx("Without escalation", "بدون تصعيد")}
            spark={DAILY.ai_pct.map((v) => v * 100)}
          />
          <StatTile
            label={tx("Avg response", "متوسط الرد")}
            value="19"
            unit="s"
            delta="-23s"
            sub={tx("First reply", "الرد الأول")}
            spark={DAILY.responseTime.slice().reverse()}
            invert
          />
          <StatTile
            label={tx("Pipeline value", "قيمة المبيعات")}
            value={
              ticketsSummary
                ? `${ticketsSummary.currency} ${ticketsSummary.openValue.toLocaleString()}`
                : "0"
            }
            delta="+18.2%"
            sub={tx("Open tickets", "تذاكر مفتوحة")}
            spark={[120, 148, 162, 178, 201, 228, 242]}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.65fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <h3>{tx("Conversations · last 7 days", "المحادثات · آخر ٧ أيام")}</h3>
                <div className="sub">{tx("AI handled vs human-assisted", "تم بالذكاء مقابل بمساعدة بشرية")}</div>
              </div>
              <div style={{ display: "flex", gap: 14, fontSize: 12 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--accent)" }} /> {tx("AI", "ذكاء")}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 10, height: 2, background: "var(--ink-3)" }} /> {tx("Human", "بشري")}
                </span>
              </div>
            </div>
            <div style={{ padding: "16px 16px 8px" }}>
              <AreaChart
                a={DAILY.resolved}
                b={[42, 34, 37, 36, 37, 41, 45]}
                w={680}
                h={180}
              />
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
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Your AI agents", "وكلاؤك الذكيون")}</h3>
              <button className="btn ghost sm" onClick={() => setRoute("agents")}>
                {tx("Manage", "إدارة")}
                <IconChev w={12} />
              </button>
            </div>
            <div style={{ padding: 8 }}>
              {AGENTS.filter((a) => a.status === "live").map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 8px",
                    borderRadius: 8,
                  }}
                >
                  <Avatar agent={a} ai size="lg" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 500 }}>{a.name}</span>
                      <Badge kind="ok" dot>live</Badge>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                      {a.role} · {a.convs} convos · CSAT {a.csat}
                    </div>
                  </div>
                  <div style={{ width: 64 }}>
                    <Spark values={[8, 14, 12, 18, 20, 22, 28]} w={64} h={22} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <h3>{tx("Live activity", "النشاط المباشر")}</h3>
              <span className="badge ai">
                <span className="dot pulse" />
                {tx("streaming", "مباشر")}
              </span>
            </div>
            <div style={{ padding: "4px 6px 12px" }}>
              {activity.map((row, i) => {
                const agent = row.role === "ai" ? findAgent(row.who) : undefined;
                return (
                  <div
                    key={ACTIVITY_KEYS[i]}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                    }}
                  >
                    {row.role === "ai" && agent ? (
                      <Avatar agent={agent} ai size="sm" />
                    ) : (
                      <Avatar name={row.who} color="270" size="sm" />
                    )}
                    <div style={{ fontSize: 13, flex: 1 }}>
                      <span style={{ fontWeight: 500 }}>{row.who}</span>
                      <span style={{ color: "var(--ink-2)" }}> {row.what} </span>
                      <span style={{ fontWeight: 500 }}>{row.to}</span>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      {row.t}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Top intents", "أهم النوايا")}</h3>
              <span className="sub">{tx("today", "اليوم")}</span>
            </div>
            <div style={{ padding: 16 }}>
              {INTENTS.slice(0, 6).map((it, i) => (
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
                        width: `${it.pct * 3}%`,
                        height: "100%",
                        background: "var(--accent)",
                        opacity: 0.4 + i * 0.1,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Pipeline performance", "أداء خط المبيعات")}</h3>
              <span className="sub">{tx("all time", "كل الفترة")}</span>
            </div>
            <div style={{ padding: "12px 16px 16px" }}>
              {(() => {
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
              {summaryError ? (
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
                <h3 className={convLoading && !conversations ? "pulse" : undefined}>
                  {tx("Messages by channel", "الرسائل حسب القناة")}
                </h3>
                <div className="sub">
                  {tx("Inbound volume across platforms", "الحجم الوارد عبر القنوات")}
                </div>
              </div>
            </div>
            <div style={{ padding: "12px 16px 16px" }}>
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Dashboard = memo(DashboardImpl);
export default Dashboard;
