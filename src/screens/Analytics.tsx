import { memo } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge } from "@/components/Badge";
import { Donut, Heatmap, Spark } from "@/components/charts";
import {
  IconArrowDown,
  IconArrowUp,
  IconBook,
  IconCal,
  IconChevDown,
  IconPlus,
} from "@/icons";
import { AGENTS } from "@/data/agents";
import { TEAM } from "@/data/team";
import { DAILY, INTENTS } from "@/data/analytics";
import {
  FUNNEL,
  HEATMAP,
  HUMAN_LEADERBOARD,
  RESOLUTION_MIX,
  WEEKLY_VOLUME,
  type WeeklyBar,
} from "@/data/analytics-extras";

interface BigStatProps {
  label: string;
  value: string;
  unit?: string;
  delta: string;
  spark?: number[];
  invert?: boolean;
}

function BigStat({ label, value, unit, delta, spark, invert }: BigStatProps) {
  const isDown = delta.startsWith("-");
  const tone = isDown ? (invert ? "" : "down") : "";
  return (
    <div className="stat" style={{ padding: 14 }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 24 }}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span className={`delta ${tone}`.trim()}>
          {isDown ? <IconArrowDown w={11} /> : <IconArrowUp w={11} />}
          {delta}
        </span>
        {spark && <Spark values={spark} w={64} h={20} />}
      </div>
    </div>
  );
}

function StackedBars({ weeks }: { weeks: WeeklyBar[] }) {
  const max = Math.max(...weeks.map((w) => w.ai + w.hum + w.esc));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 24, height: 200 }}>
      {weeks.map((w, i) => {
        const total = w.ai + w.hum + w.esc;
        const h = (total / max) * 180;
        return (
          <div
            key={i}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
          >
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
              {total.toLocaleString()}
            </span>
            <div
              style={{
                width: "100%",
                maxWidth: 70,
                height: h,
                display: "flex",
                flexDirection: "column",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div style={{ flex: w.esc, background: "var(--bad)", opacity: 0.6 }} />
              <div style={{ flex: w.hum, background: "var(--ink-3)" }} />
              <div style={{ flex: w.ai, background: "var(--accent)", opacity: 0.7 }} />
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              W{i + 1}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface LeaderEntry {
  id: string;
  name: string;
  color: string;
  isHuman: boolean;
  agent?: (typeof AGENTS)[number];
  resolved: number;
  csat: number;
}

function buildLeaderboard(): LeaderEntry[] {
  const ai: LeaderEntry[] = AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    isHuman: false,
    agent: a,
    resolved: a.convs,
    csat: a.csat,
  }));
  const humans: LeaderEntry[] = TEAM.slice(2, 4).map((m) => {
    const extras = HUMAN_LEADERBOARD.find((x) => x.id === m.id);
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      isHuman: true,
      resolved: extras?.resolved ?? 60,
      csat: extras?.csat ?? 90,
    };
  });
  return [...ai, ...humans].sort((a, b) => b.resolved - a.resolved);
}

const LEGEND_OPACITIES = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

function AnalyticsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const leaderboard = buildLeaderboard();

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <PageHeader
        title={tx("Analytics", "التحليلات")}
        subtitle={tx(
          "How your AI and team performed across all channels",
          "أداء الذكاء والفريق",
        )}
        actions={
          <>
            <button className="btn">
              <IconCal w={13} />
              {tx("Last 30 days", "آخر ٣٠ يوم")}
              <IconChevDown w={12} />
            </button>
            <button className="btn">
              <IconBook w={13} />
              {tx("Export", "تصدير")}
            </button>
            <button className="btn primary">
              <IconPlus w={13} />
              {tx("New report", "تقرير جديد")}
            </button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
        {/* Top stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          <BigStat
            label={tx("Conversations", "محادثات")}
            value="8,432"
            delta="+12.4%"
            spark={[180, 220, 210, 240, 270, 260, 310]}
          />
          <BigStat
            label={tx("AI handled", "حل بالذكاء")}
            value="86%"
            delta="+4.1pp"
            spark={DAILY.ai_pct.map((v) => v * 100)}
          />
          <BigStat
            label={tx("CSAT", "تقييم")}
            value="91"
            unit="/100"
            delta="+2"
            spark={DAILY.csat}
          />
          <BigStat
            label={tx("Avg response", "الرد")}
            value="19"
            unit="s"
            delta="-23s"
            invert
            spark={DAILY.responseTime.slice().reverse()}
          />
          <BigStat
            label={tx("Revenue attributed", "إيرادات منسوبة")}
            value="SAR 412k"
            delta="+18.2%"
            spark={[120, 148, 162, 178, 201, 228, 242]}
          />
        </div>

        {/* Volume + AI vs Human breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <h3>{tx("Conversation volume", "حجم المحادثات")}</h3>
                <div className="sub">
                  {tx("Last 30 days · grouped by week", "آخر ٣٠ يوم")}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 14,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--accent)", opacity: 0.7 }} />
                  {tx("AI", "ذكاء")}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--ink-3)" }} />
                  {tx("Human", "بشري")}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, background: "var(--bad)" }} />
                  {tx("Escalated", "مُصعّد")}
                </span>
              </div>
            </div>
            <div style={{ padding: "16px 18px" }}>
              <StackedBars weeks={WEEKLY_VOLUME} />
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Resolution mix", "نوع الحل")}</h3>
              <span className="sub">{tx("By outcome", "حسب النتيجة")}</span>
            </div>
            <div style={{ padding: 18, display: "flex", alignItems: "center", gap: 18 }}>
              <div style={{ position: "relative" }}>
                <Donut
                  size={150}
                  thickness={20}
                  items={RESOLUTION_MIX.map((m) => ({ value: m.pct, color: m.color }))}
                />
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "grid",
                    placeItems: "center",
                    textAlign: "center",
                  }}
                >
                  <div>
                    <div className="display" style={{ fontSize: 28, color: "var(--ink)" }}>
                      86%
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {tx("AI auto-resolved", "حل تلقائي")}
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ flex: 1, display: "grid", gap: 10 }}>
                {RESOLUTION_MIX.map((it) => (
                  <div
                    key={it.labelEn}
                    style={{ display: "flex", alignItems: "center", gap: 10 }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        background: it.color,
                        borderRadius: 2,
                      }}
                    />
                    <span style={{ flex: 1, fontSize: 13 }}>
                      {tx(it.labelEn, it.labelAr)}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-3)" }}
                    >
                      {it.count}
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        width: 44,
                        textAlign: "end",
                      }}
                    >
                      {it.pct}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Heatmap + agents leaderboard */}
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <h3>
                {tx("When are customers messaging?", "متى يراسلك العملاء؟")}
              </h3>
              <span className="sub">Asia/Riyadh</span>
            </div>
            <div style={{ padding: "12px 18px 8px", overflowX: "auto" }}>
              <Heatmap data={HEATMAP} cell={20} w={580} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--ink-3)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <span>{tx("less", "أقل")}</span>
                {LEGEND_OPACITIES.map((v) => (
                  <span
                    key={v}
                    style={{
                      width: 14,
                      height: 14,
                      background: `oklch(0.78 0.18 150 / ${v})`,
                      borderRadius: 3,
                    }}
                  />
                ))}
                <span>{tx("more", "أكثر")}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Agent leaderboard", "ترتيب الوكلاء")}</h3>
              <span className="sub">{tx("by resolved", "حسب الحلول")}</span>
            </div>
            <div style={{ padding: "8px 6px" }}>
              {leaderboard.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 6,
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--ink-3)", width: 16 }}
                  >
                    #{i + 1}
                  </span>
                  {p.isHuman || !p.agent ? (
                    <Avatar name={p.name} color={p.color} size="sm" />
                  ) : (
                    <Avatar agent={p.agent} ai size="sm" />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {p.name}
                      {p.isHuman ? (
                        <Badge kind="human">human</Badge>
                      ) : (
                        <Badge kind="ai">AI</Badge>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                      CSAT {p.csat || "—"}
                    </div>
                  </div>
                  <div style={{ width: 80 }}>
                    <Spark
                      values={[8, 14, 12, 18, 20, 22, p.resolved / 10]}
                      w={80}
                      h={20}
                    />
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      width: 44,
                      textAlign: "end",
                    }}
                  >
                    {p.resolved}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Funnel + intents */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div className="card">
            <div className="card-h">
              <h3>{tx("Lead → Customer funnel", "قمع التحويل")}</h3>
            </div>
            <div style={{ padding: 18, display: "grid", gap: 6 }}>
              {FUNNEL.map((it, i) => (
                <div
                  key={it.labelEn}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "180px 1fr 80px",
                    alignItems: "center",
                    gap: 12,
                    padding: "4px 0",
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {tx(it.labelEn, it.labelAr)}
                  </span>
                  <div
                    style={{
                      height: 22,
                      background: "var(--bg-2)",
                      borderRadius: 4,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${it.width * 100}%`,
                        height: "100%",
                        background: "var(--accent)",
                        opacity: 0.3 + i * 0.15,
                      }}
                    />
                    <span
                      className="mono"
                      style={{
                        position: "absolute",
                        insetInlineStart: 8,
                        top: 3,
                        fontSize: 11,
                        color: "var(--ink-1)",
                      }}
                    >
                      {Math.round(it.width * 100)}%
                    </span>
                  </div>
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--ink-2)", textAlign: "end" }}
                  >
                    {it.value.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>{tx("Top intents", "أهم النوايا")}</h3>
              <span className="sub">{tx("auto-classified", "مصنّفة")}</span>
            </div>
            <div style={{ padding: 18 }}>
              {INTENTS.map((it, i) => (
                <div
                  key={it.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 1fr 80px 60px",
                    alignItems: "center",
                    gap: 12,
                    padding: "8px 0",
                  }}
                >
                  <span style={{ fontSize: 13 }}>{it.name}</span>
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
                        opacity: 0.4 + i * 0.08,
                      }}
                    />
                  </div>
                  <span
                    className="mono"
                    style={{ fontSize: 12, color: "var(--ink-2)" }}
                  >
                    {it.count}
                  </span>
                  <span
                    className="mono"
                    style={{ fontSize: 12, fontWeight: 500, textAlign: "end" }}
                  >
                    {it.pct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const Analytics = memo(AnalyticsImpl);
export default Analytics;
