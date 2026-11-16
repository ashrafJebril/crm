import { useMemo } from "react";
import { Donut } from "@/components/charts";
import { useFetch } from "@/api/useFetch";
import type { ChannelDto, Lang } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { InsightStat, SectionCard, SectionTiles, ShareBar, gridCols } from "./InsightsUi";
import { insightsErrorKey, insightsErrorText } from "./insightsErrors";
import { formatCount, formatDuration, formatHours, formatRate, numberLabel, peaksScale, share } from "./insightsModel";
import { insightsPath, type InsightsParams } from "./insightsParams";
import type { Peaks, ResolutionMix, SupportInsights as SupportDto } from "./insightsTypes";
import { TeamTable } from "./TeamTable";

/** Resolution-mix hues in a fixed order (identity, not status). */
const MIX: { key: keyof ResolutionMix; color: string; en: string; ar: string }[] = [
  { key: "ai", color: "var(--accent)", en: "Resolved by AI", ar: "حلّها الذكاء الاصطناعي" },
  { key: "human", color: "var(--human)", en: "Resolved by the team", ar: "حلّها الفريق" },
  { key: "escalated", color: "var(--info)", en: "Escalated", ar: "مُصعَّدة" },
  { key: "closed", color: "var(--ink-3)", en: "Closed", ar: "مغلقة" },
];

export function SupportInsights({
  params,
  setParams,
  today,
  lang,
  tx,
  canChannels,
}: {
  params: InsightsParams;
  setParams: (patch: Partial<InsightsParams>) => void;
  today: string;
  lang: Lang;
  tx: Tx;
  canChannels: boolean;
}) {
  const q = useFetch<SupportDto>(insightsPath("support", params, today));
  const channelsQ = useFetch<ChannelDto[]>(canChannels ? "/channels" : null);
  const numbers = (channelsQ.data ?? []).filter((c) => c.kind === "whatsapp");
  const d = q.data;

  const numberSelect = numbers.length > 1 || params.channel ? (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
      <span className="muted">{tx("WhatsApp number", "رقم واتساب")}</span>
      <select value={params.channel ?? ""} onChange={(e) => setParams({ channel: e.target.value || null })}>
        <option value="">{tx("All numbers", "جميع الأرقام")}</option>
        {numbers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.displayName || c.phoneNumber || c.id}
          </option>
        ))}
        {params.channel && !numbers.some((c) => c.id === params.channel) && (
          <option value={params.channel}>{tx("Selected number", "الرقم المحدد")}</option>
        )}
      </select>
    </label>
  ) : null;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="tabs" role="tablist" style={{ padding: 0, border: 0, background: "transparent" }}>
          <button type="button" role="tab" aria-selected={!params.team} className={`tab ${!params.team ? "active" : ""}`.trim()} onClick={() => setParams({ team: false })}>
            {tx("Overview", "نظرة عامة")}
          </button>
          <button type="button" role="tab" aria-selected={params.team} className={`tab ${params.team ? "active" : ""}`.trim()} onClick={() => setParams({ team: true })}>
            {tx("Team", "الفريق")}
          </button>
        </div>
        <div style={{ marginInlineStart: "auto" }}>{numberSelect}</div>
      </div>

      {q.error && (
        <div role="alert" style={{ padding: 10, fontSize: 12.5, color: "var(--bad)", border: "1px solid var(--line-soft)", borderRadius: 8, display: "flex", gap: 10, alignItems: "center" }}>
          <span>{insightsErrorText(q.error, tx)}</span>
          {insightsErrorKey(q.error) === "insights.channel_not_found" && (
            <button type="button" className="btn" onClick={() => setParams({ channel: null })}>
              {tx("Show all numbers", "عرض جميع الأرقام")}
            </button>
          )}
        </div>
      )}
      {!d && !q.error && <div className="muted" style={{ fontSize: 12.5 }}>{tx("Loading…", "جارٍ التحميل…")}</div>}

      {d && params.team && <TeamTable section={d.team} lang={lang} tx={tx} />}

      {d && !params.team && (
        <>
          <SectionTiles section={d.headline} tx={tx}>
            {(h) => (
              <div style={gridCols(170)}>
                <InsightStat label={tx("Conversations", "المحادثات")} value={formatCount(h.conversations)} />
                <InsightStat
                  label={tx("AI resolution rate", "نسبة الحل بالذكاء الاصطناعي")}
                  value={formatRate(h.aiResolutionRate)}
                  sub={tx(`${formatCount(h.aiResolved)} of ${formatCount(h.decided)} decided`, `${formatCount(h.aiResolved)} من ${formatCount(h.decided)} محسومة`)}
                  tip={tx("Latest outcome of each conversation", "آخر نتيجة لكل محادثة")}
                />
                <InsightStat
                  label={tx("Median first response", "متوسط أول رد (الوسيط)")}
                  value={formatDuration(h.medianFirstResponseSec, lang)}
                  sub={h.unanswered ? tx(`${formatCount(h.unanswered)} not answered yet`, `${formatCount(h.unanswered)} بلا رد بعد`) : undefined}
                  tip={tx("First reply by a person; replies only the AI sent are left out", "أول رد من شخص؛ لا تُحتسب الردود التي أرسلها الذكاء الاصطناعي وحده")}
                />
                <InsightStat label={tx("Median handling time", "الوسيط لمدة المعالجة")} value={formatDuration(h.medianHandlingSec, lang)} />
                <InsightStat
                  label={tx("Time saved", "الوقت الموفَّر")}
                  value={formatHours(h.timeSaved.hours, lang)}
                  sub={tx(`${formatCount(h.timeSaved.customerMessages)} messages answered first by AI`, `${formatCount(h.timeSaved.customerMessages)} رسالة ردّ عليها الذكاء الاصطناعي أولًا`)}
                  tip={tx("Estimated at 60 seconds per customer message the AI answered first", "تقدير: 60 ثانية لكل رسالة عميل ردّ عليها الذكاء الاصطناعي أولًا")}
                />
                <InsightStat label={tx("Turned into tickets", "تحوّلت إلى تذاكر")} value={formatRate(h.ticketShare)} />
              </div>
            )}
          </SectionTiles>

          <div style={gridCols(320)}>
            <SectionCard
              title={tx("Resolution mix", "توزيع الحلول")}
              sub={tx("Latest outcome of each conversation", "آخر نتيجة لكل محادثة")}
              section={d.resolutionMix}
              tx={tx}
              empty={(m) => m.ai + m.human + m.escalated + m.closed === 0}
            >
              {(m) => <MixChart mix={m} tx={tx} />}
            </SectionCard>
            <SectionCard
              title={tx("Conversations by number", "المحادثات حسب الرقم")}
              section={d.byNumber}
              tx={tx}
              empty={(rows) => rows.length === 0}
            >
              {(rows) => {
                const max = Math.max(1, ...rows.map((r) => r.conversations));
                return (
                  <div style={{ display: "grid", gap: 10 }}>
                    {rows.map((r) => (
                      <div key={r.channelId ?? "unassigned"} style={{ display: "grid", gap: 4 }}>
                        <div style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                          <span style={{ flex: 1 }}>{numberLabel(r, lang)}</span>
                          <span className="mono">{formatCount(r.conversations)}</span>
                          <span className="mono muted" title={tx("AI resolution rate", "نسبة الحل بالذكاء الاصطناعي")}>
                            {tx("AI", "ذكاء")} {formatRate(r.aiResolutionRate)}
                          </span>
                        </div>
                        <ShareBar fraction={share(r.conversations, max)} />
                      </div>
                    ))}
                  </div>
                );
              }}
            </SectionCard>
          </div>

          <SectionCard
            title={tx("Busiest hours", "أوقات الذروة")}
            sub={tx(`Customer messages by day and hour (${d.range.tz})`, `رسائل العملاء حسب اليوم والساعة (${d.range.tz})`)}
            section={d.peaks}
            tx={tx}
            empty={(p) => p.byHour.every((v) => v === 0)}
          >
            {(p) => <PeaksGrid peaks={p} lang={lang} tx={tx} />}
          </SectionCard>

          <SectionCard
            title={tx("Topic friction", "المواضيع الأصعب")}
            sub={tx("Topics most often escalated or negative", "المواضيع الأكثر تصعيدًا أو سلبية")}
            section={d.topicFriction}
            tx={tx}
            empty={(rows) => rows.length === 0}
          >
            {(rows) => (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ inlineSize: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "start" }}>{tx("Topic", "الموضوع")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Conversations", "المحادثات")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Escalated", "مُصعَّدة")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Negative", "سلبية")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.topic}>
                        <td>{r.topic}</td>
                        <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.count)}</td>
                        <td className="mono" style={{ textAlign: "end" }}>{formatRate(r.escalatedShare)}</td>
                        <td className="mono" style={{ textAlign: "end" }}>{formatRate(r.negativeShare)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

function MixChart({ mix, tx }: { mix: ResolutionMix; tx: Tx }) {
  const total = mix.ai + mix.human + mix.escalated + mix.closed;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
      <Donut items={MIX.map((m) => ({ value: mix[m.key], color: m.color, label: tx(m.en, m.ar) }))} />
      <div style={{ display: "grid", gap: 6 }}>
        {MIX.map((m) => (
          <div key={m.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <span aria-hidden style={{ inlineSize: 8, blockSize: 8, borderRadius: "50%", background: m.color }} />
            <span>{tx(m.en, m.ar)}</span>
            <span className="mono" style={{ color: "var(--ink-3)" }}>
              {formatCount(mix[m.key])} · {formatRate(total ? Math.round((mix[m.key] / total) * 1000) / 10 : null)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 7 × 24 heat grid in the language's week order, with a screen-reader table. */
function PeaksGrid({ peaks, lang, tx }: { peaks: Peaks; lang: Lang; tx: Tx }) {
  const scaled = useMemo(() => peaksScale(peaks.matrix, lang), [peaks.matrix, lang]);
  const cell = 18;
  return (
    <div style={{ overflowX: "auto" }}>
      <div aria-hidden style={{ display: "grid", gridTemplateColumns: `72px repeat(24, ${cell}px)`, gap: 2, alignItems: "center", inlineSize: "max-content" }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="mono" style={{ fontSize: 9, color: "var(--ink-3)", textAlign: "center" }}>
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {scaled.rows.map((r) => (
          <PeaksRowCells key={r.dow} row={r} cell={cell} tx={tx} />
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11, marginBlockStart: 8 }}>
        {tx(`Busiest hour: ${formatCount(scaled.max)} messages`, `أعلى ساعة: ${formatCount(scaled.max)} رسالة`)}
      </div>
      <table style={{ position: "absolute", inlineSize: 1, blockSize: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        <caption>{tx("Customer messages by day and hour", "رسائل العملاء حسب اليوم والساعة")}</caption>
        <thead>
          <tr>
            <th scope="col">{tx("Day", "اليوم")}</th>
            {Array.from({ length: 24 }, (_, h) => (
              <th key={h} scope="col">{`${h}:00`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scaled.rows.map((r) => (
            <tr key={r.dow}>
              <th scope="row">{r.label}</th>
              {r.cells.map((c) => (
                <td key={c.hour}>{c.count}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PeaksRowCells({ row, cell, tx }: { row: ReturnType<typeof peaksScale>["rows"][number]; cell: number; tx: Tx }) {
  return (
    <>
      <span style={{ fontSize: 11, color: "var(--ink-2)" }}>{row.label}</span>
      {row.cells.map((c) => (
        <span
          key={c.hour}
          title={tx(`${row.label} ${c.hour}:00 · ${formatCount(c.count)} messages`, `${row.label} ${c.hour}:00 · ${formatCount(c.count)} رسالة`)}
          style={{
            inlineSize: cell,
            blockSize: cell,
            borderRadius: 3,
            background: c.count ? `color-mix(in oklab, var(--accent) ${Math.round(15 + 85 * c.intensity)}%, var(--bg-2))` : "var(--bg-2)",
          }}
        />
      ))}
    </>
  );
}
