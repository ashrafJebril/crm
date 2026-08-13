import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { AreaChart, Donut, Spark } from "@/components/charts";
import { useFetch } from "@/api/useFetch";
import type { Campaign } from "@/lib/types";

interface DailyRow { day: string; total: number; human: number }
interface Summary {
  counts: { contacts: number; conversations: number; appointments: number; campaigns: number; templates: number; escalated: number; unread: number };
  daily: DailyRow[];
  deltas: { conversationsPct: number; conversationsThis7: number; conversationsPrev7: number };
  windowDays: 7 | 30;
  channels: { channel: string; count: number }[];
}
interface PipelineSummary {
  openValue: number; currency: string; winRate: number;
  wonCount: number; lostCount: number; avgCloseHours: number; totalTickets: number;
}
interface SocialPlatformOverview {
  platform: string;
  followers: { current: number; delta: number; series: { date: string; count: number }[] };
  impressions: number | null; reach: number | null; engagement: number | null;
  likes: number | null; comments: number | null; shares: number | null;
}
interface SocialOverview {
  available: boolean;
  reason?: "not_connected" | "plan" | "upstream";
  windowDays?: 7 | 30;
  platforms?: SocialPlatformOverview[];
}

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "var(--ok)",
  instagram: "#E1306C",
  facebook: "#1877F2",
  tiktok: "var(--ink-3)",
  webchat: "var(--accent)",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>}
    </div>
  );
}

function AnalyticsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const [days, setDays] = useState<7 | 30>(7);

  const summaryQ = useFetch<Summary>(`/dashboard/summary?days=${days}`);
  const pipelineQ = useFetch<PipelineSummary>("/tickets/dashboard/summary");
  const campaignsQ = useFetch<Campaign[]>("/campaigns");
  const socialQ = useFetch<SocialOverview>(`/social/analytics/overview?days=${days}`);

  const s = summaryQ.data;
  const p = pipelineQ.data;
  const campaigns = campaignsQ.data ?? [];
  const so = socialQ.data;

  const msgTotal = s ? s.daily.reduce((a, d) => a + d.total, 0) : 0;
  const totals = campaigns.reduce(
    (a, c) => ({ sent: a.sent + c.sent, read: a.read + c.read, replied: a.replied + c.replied }),
    { sent: 0, read: 0, replied: 0 },
  );

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Analytics", "التحليلات")}
        subtitle={tx(
          "How your team performed across all channels",
          "أداء فريقك عبر جميع القنوات",
        )}
        actions={
          <div style={{ display: "flex", gap: 6 }}>
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                className={`btn ${days === d ? "primary" : ""}`.trim()}
                onClick={() => setDays(d)}
              >
                {d === 7 ? tx("Last 7 days", "آخر ٧ أيام") : tx("Last 30 days", "آخر ٣٠ يوم")}
              </button>
            ))}
          </div>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 14 }}>
        {(summaryQ.error || pipelineQ.error) && (
          <div style={{ padding: 10, fontSize: 12, color: "var(--bad)", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
            {summaryQ.error ?? pipelineQ.error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
          <Stat label={tx("Contacts", "جهات الاتصال")} value={s ? s.counts.contacts.toLocaleString() : "…"} />
          <Stat
            label={tx("Conversations", "المحادثات")}
            value={s ? s.counts.conversations.toLocaleString() : "…"}
            sub={s ? `${s.deltas.conversationsPct >= 0 ? "+" : ""}${s.deltas.conversationsPct}% ${tx("vs last week", "مقارنة بالأسبوع الماضي")}` : undefined}
          />
          <Stat
            label={days === 7 ? tx("Messages (7d)", "الرسائل (٧ي)") : tx("Messages (30d)", "الرسائل (٣٠ي)")}
            value={s ? msgTotal.toLocaleString() : "…"}
          />
          <Stat label={tx("Unread", "غير المقروءة")} value={s ? s.counts.unread.toLocaleString() : "…"} />
        </div>

        <div className="card">
          <div className="card-h">
            <h3>{tx("Message volume", "حجم الرسائل")}</h3>
            <span className="sub">{tx("All messages vs. sent by team", "كل الرسائل مقابل رسائل الفريق")}</span>
          </div>
          <div style={{ padding: 18, overflowX: "auto" }}>
            {s && s.daily.length > 1 && (
              <AreaChart a={s.daily.map((d) => d.total)} b={s.daily.map((d) => d.human)} w={720} h={180} />
            )}
          </div>
        </div>

        {so && so.available === false && (so.reason === "plan" || so.reason === "upstream") && (
          <div className="card">
            <div className="card-h"><h3>{tx("Social performance", "الأداء الاجتماعي")}</h3></div>
            <div style={{ padding: 18, fontSize: 13, color: "var(--ink-3)" }}>
              {so.reason === "plan"
                ? tx(
                    "Social analytics isn't included in the current Zernio plan.",
                    "تحليلات التواصل غير متضمنة في خطة Zernio الحالية.",
                  )
                : tx(
                    "Social analytics is temporarily unavailable.",
                    "تحليلات التواصل غير متاحة مؤقتًا.",
                  )}
            </div>
          </div>
        )}
        {so?.available && (so.platforms?.length ?? 0) > 0 && (
          <div className="card">
            <div className="card-h">
              <h3>{tx("Social performance", "الأداء الاجتماعي")}</h3>
              <span className="sub">
                {days === 7 ? tx("Last 7 days", "آخر ٧ أيام") : tx("Last 30 days", "آخر ٣٠ يوم")}
              </span>
            </div>
            <div style={{ padding: 18, display: "grid", gap: 14 }}>
              {so.platforms!.map((p) => {
                const fmt = (v: number | null) => (v === null ? "—" : v.toLocaleString());
                const deltaTone = p.followers.delta > 0 ? "var(--ok)" : p.followers.delta < 0 ? "var(--bad)" : "var(--ink-3)";
                return (
                  <div
                    key={p.platform}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "180px 1fr",
                      gap: 16,
                      alignItems: "center",
                      padding: 12,
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-soft)",
                      borderRadius: 10,
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: CHANNEL_COLORS[p.platform] ?? "var(--ink-3)",
                          }}
                        />
                        <span style={{ fontWeight: 600, fontSize: 13, textTransform: "capitalize" }}>
                          {p.platform}
                        </span>
                      </div>
                      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>
                        {p.followers.current.toLocaleString()}
                        <span className="mono" style={{ fontSize: 11, color: deltaTone, marginInlineStart: 8 }}>
                          {p.followers.delta > 0 ? "+" : ""}
                          {p.followers.delta.toLocaleString()}
                        </span>
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase" }}>
                        {tx("Followers", "المتابعون")}
                      </div>
                      {p.followers.series.length > 1 && (
                        <div style={{ marginTop: 6 }}>
                          <Spark values={p.followers.series.map((s) => s.count)} w={140} h={24} />
                        </div>
                      )}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                      <Stat label={tx("Impressions", "مرات الظهور")} value={fmt(p.impressions)} />
                      <Stat label={tx("Reach", "الوصول")} value={fmt(p.reach)} />
                      <Stat
                        label={tx("Engagement", "التفاعل")}
                        value={fmt(
                          p.engagement ??
                            (p.likes === null && p.comments === null && p.shares === null
                              ? null
                              : (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0)),
                        )}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="card">
            <div className="card-h"><h3>{tx("Conversations by channel", "المحادثات حسب القناة")}</h3></div>
            <div style={{ padding: 18, display: "flex", gap: 20, alignItems: "center" }}>
              {s && s.channels.length > 0 ? (
                <>
                  <Donut
                    items={s.channels.map((c) => ({
                      value: c.count,
                      color: CHANNEL_COLORS[c.channel] ?? "var(--ink-3)",
                      label: c.channel,
                    }))}
                  />
                  <div style={{ display: "grid", gap: 6 }}>
                    {s.channels.map((c) => (
                      <div key={c.channel} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: CHANNEL_COLORS[c.channel] ?? "var(--ink-3)" }} />
                        <span style={{ textTransform: "capitalize" }}>{c.channel}</span>
                        <span className="mono" style={{ color: "var(--ink-3)" }}>{c.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <span className="mono muted" style={{ fontSize: 12 }}>{tx("No conversations yet.", "لا توجد محادثات بعد.")}</span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>{tx("Pipeline", "المسار")}</h3></div>
            <div style={{ padding: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Stat label={tx("Open value", "القيمة المفتوحة")} value={p ? `${p.currency} ${p.openValue.toLocaleString()}` : "…"} />
              <Stat label={tx("Win rate", "معدل الفوز")} value={p ? `${p.winRate}%` : "…"} sub={p ? `${p.wonCount} ${tx("won", "فوز")} · ${p.lostCount} ${tx("lost", "خسارة")}` : undefined} />
              <Stat label={tx("Avg. close time", "متوسط الإغلاق")} value={p ? `${p.avgCloseHours}h` : "…"} />
              <Stat label={tx("Total deals", "إجمالي الصفقات")} value={p ? p.totalTickets.toLocaleString() : "…"} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h3>{tx("Campaigns", "الحملات")}</h3>
            <span className="sub">{tx("Lifetime totals across all campaigns", "إجماليات كل الحملات")}</span>
          </div>
          <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            <Stat label={tx("Sent", "المرسلة")} value={totals.sent.toLocaleString()} />
            <Stat label={tx("Read", "المقروءة")} value={totals.read.toLocaleString()} />
            <Stat label={tx("Replied", "الردود")} value={totals.replied.toLocaleString()} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Analytics = memo(AnalyticsImpl);
export default Analytics;
