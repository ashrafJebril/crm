import { AreaChart } from "@/components/charts";
import { useFetch } from "@/api/useFetch";
import type { Lang, Pipeline } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { InsightStat, SectionCard, SectionTiles, ShareBar, gridCols } from "./InsightsUi";
import { insightsErrorKey, insightsErrorText } from "./insightsErrors";
import {
  DASH,
  SOURCE_KIND_WORDS,
  adHref,
  followUpsHref,
  formatCount,
  formatDuration,
  formatRate,
  formatShortDay,
  lostReasonLabel,
  memberLabel,
  pipelineName,
  share,
  sourceLabel,
  speedBucketLabel,
  stageLabel,
} from "./insightsModel";
import { insightsPath, type InsightsParams } from "./insightsParams";
import type { SalesInsights as SalesDto } from "./insightsTypes";

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function SalesInsights({
  params,
  setParams,
  today,
  lang,
  tx,
  canReports,
  canPipelines,
  canFollowUps,
}: {
  params: InsightsParams;
  setParams: (patch: Partial<InsightsParams>) => void;
  today: string;
  lang: Lang;
  tx: Tx;
  canReports: boolean;
  canPipelines: boolean;
  canFollowUps: boolean;
}) {
  const q = useFetch<SalesDto>(insightsPath("sales", params, today));
  const pipelinesQ = useFetch<Pipeline[]>(canPipelines ? "/pipelines" : null);
  const pipelines = (pipelinesQ.data ?? []).filter((p) => !p.archivedAt);
  const d = q.data;
  const current = d?.pipeline.id ?? params.pipeline ?? "";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{d ? pipelineName(d.pipeline, lang) : tx("Sales", "المبيعات")}</h3>
        {pipelines.length > 1 && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, marginInlineStart: "auto" }}>
            <span className="muted">{tx("Pipeline", "المسار")}</span>
            <select value={current} onChange={(e) => setParams({ pipeline: e.target.value || null })}>
              {!pipelines.some((p) => p.id === current) && <option value={current}>{d ? pipelineName(d.pipeline, lang) : DASH}</option>}
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {lang === "ar" ? p.nameAr || p.name : p.name || p.nameAr}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {q.error && (
        <div role="alert" style={{ padding: 10, fontSize: 12.5, color: "var(--bad)", border: "1px solid var(--line-soft)", borderRadius: 8, display: "flex", gap: 10, alignItems: "center" }}>
          <span>{insightsErrorText(q.error, tx)}</span>
          {insightsErrorKey(q.error) === "insights.pipeline_not_found" && params.pipeline && (
            <button type="button" className="btn" onClick={() => setParams({ pipeline: null })}>
              {tx("Use the default pipeline", "استخدم المسار الافتراضي")}
            </button>
          )}
        </div>
      )}
      {!d && !q.error && <div className="muted" style={{ fontSize: 12.5 }}>{tx("Loading…", "جارٍ التحميل…")}</div>}

      {d && (
        <>
          <SectionTiles section={d.headline} tx={tx}>
            {(h) => (
              <div style={gridCols(170)}>
                <InsightStat label={tx("New leads", "عملاء محتملون جدد")} value={formatCount(h.leads)} />
                <InsightStat
                  label={tx("Replied", "تم الرد")}
                  value={formatCount(h.replied)}
                  sub={tx(`${formatRate(pct(h.replied, h.leads))} of leads`, `${formatRate(pct(h.replied, h.leads))} من العملاء المحتملين`)}
                  tip={tx("A reply by the team or the AI counts", "يُحتسب رد الفريق أو الذكاء الاصطناعي")}
                />
                <InsightStat
                  label={tx("Median speed to reply", "الوسيط لسرعة الرد")}
                  value={formatDuration(h.medianSpeedToReplySec, lang)}
                  tip={tx("Time from a new lead to the team's first reply", "المدة من وصول العميل المحتمل حتى أول رد من الفريق")}
                />
                <InsightStat label={tx("Waiting for a reply", "بانتظار الرد")} value={formatCount(h.waiting)} />
                <InsightStat
                  label={tx("Won", "تم الفوز")}
                  value={formatCount(h.won)}
                  sub={tx(`${formatRate(pct(h.won, h.leads))} of leads`, `${formatRate(pct(h.won, h.leads))} من العملاء المحتملين`)}
                />
              </div>
            )}
          </SectionTiles>

          <div style={gridCols(320)}>
            <SectionCard
              title={tx("Speed to reply", "سرعة الرد")}
              sub={tx("Leads by time to the first reply", "العملاء المحتملون حسب مدة أول رد")}
              section={d.distribution}
              tx={tx}
              empty={(rows) => rows.every((r) => r.count === 0)}
            >
              {(rows) => {
                const max = Math.max(1, ...rows.map((r) => r.count));
                return (
                  <div style={{ display: "grid", gap: 8 }}>
                    {rows.map((r) => (
                      <div key={r.bucket} style={{ display: "grid", gridTemplateColumns: "110px 1fr 48px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                        <span>{speedBucketLabel(r.bucket, lang)}</span>
                        <ShareBar fraction={share(r.count, max)} color={r.bucket === "not_replied" ? "var(--ink-3)" : "var(--accent)"} />
                        <span className="mono" style={{ textAlign: "end" }}>{formatCount(r.count)}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            </SectionCard>

            <SectionCard
              title={tx("Weekly trend", "الاتجاه الأسبوعي")}
              section={d.weekly}
              tx={tx}
              empty={(rows) => rows.every((r) => r.leads === 0 && r.won === 0)}
            >
              {(rows) => (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", gap: 14, fontSize: 12 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span aria-hidden style={{ inlineSize: 14, blockSize: 2, background: "var(--accent)" }} />
                      {tx("Leads", "العملاء المحتملون")}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span aria-hidden style={{ inlineSize: 14, blockSize: 0, borderBlockStart: "2px dashed var(--ink-3)" }} />
                      {tx("Won", "تم الفوز")}
                    </span>
                  </div>
                  {rows.length > 1 && (
                    <div aria-hidden style={{ overflowX: "auto" }}>
                      <AreaChart a={rows.map((r) => r.leads)} b={rows.map((r) => r.won)} w={420} h={140} />
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5 }} className="mono muted">
                    <span>{formatShortDay(rows[0].weekStart, lang)}</span>
                    <span>{formatShortDay(rows[rows.length - 1].weekStart, lang)}</span>
                  </div>
                  <details>
                    <summary style={{ fontSize: 12, cursor: "pointer" }}>{tx("Show as a table", "عرض كجدول")}</summary>
                    <table className="tbl" style={{ inlineSize: "100%" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "start" }}>{tx("Week of", "أسبوع")}</th>
                          <th style={{ textAlign: "end" }}>{tx("Leads", "العملاء المحتملون")}</th>
                          <th style={{ textAlign: "end" }}>{tx("Won", "تم الفوز")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.weekStart}>
                            <td>{formatShortDay(r.weekStart, lang)}</td>
                            <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.leads)}</td>
                            <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.won)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                </div>
              )}
            </SectionCard>
          </div>

          <div style={gridCols(320)}>
            <SectionCard title={tx("Lead sources", "مصادر العملاء المحتملين")} section={d.sources} tx={tx} empty={(rows) => rows.length === 0}>
              {(rows) => (
                <table className="tbl" style={{ inlineSize: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "start" }}>{tx("Source", "المصدر")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Leads", "العملاء المحتملون")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Won", "تم الفوز")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const kind = SOURCE_KIND_WORDS[r.kind];
                      const label = sourceLabel(r, lang);
                      return (
                        <tr key={`${r.kind}:${r.id ?? r.key}`}>
                          <td>
                            {r.kind === "ad" && r.id && canReports ? <a href={adHref(r.id)}>{label}</a> : label}
                            {kind && <span className="chip" style={{ marginInlineStart: 6, fontSize: 10.5 }}>{tx(kind[0], kind[1])}</span>}
                          </td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.leads)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.won)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </SectionCard>

            <SectionCard
              title={tx("Stage funnel", "مراحل المسار")}
              sub={tx("Leads that reached each stage", "العملاء المحتملون الذين بلغوا كل مرحلة")}
              section={d.funnel}
              tx={tx}
              empty={(rows) => rows.length === 0}
            >
              {(rows) => {
                const top = Math.max(1, ...rows.map((r) => r.reached));
                return (
                  <div style={{ display: "grid", gap: 8 }}>
                    {rows.map((r) => (
                      <div key={r.stageId} style={{ display: "grid", gridTemplateColumns: "120px 1fr 48px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                        <span>{stageLabel(r, lang)}</span>
                        <ShareBar fraction={share(r.reached, top)} color={r.isWon ? "var(--ok)" : r.isTerminal ? "var(--ink-3)" : "var(--accent)"} />
                        <span className="mono" style={{ textAlign: "end" }}>{formatCount(r.reached)}</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            </SectionCard>
          </div>

          <SectionCard title={tx("Lost reasons", "أسباب الخسارة")} section={d.lostReasons} tx={tx} empty={(rows) => rows.length === 0}>
            {(rows) => {
              const total = rows.reduce((a, r) => a + r.count, 0);
              return (
                <div style={{ display: "grid", gap: 8 }}>
                  {rows.map((r, i) => (
                    <div key={r.reasonId ?? `none-${i}`} style={{ display: "grid", gridTemplateColumns: "minmax(120px, 220px) 1fr 90px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                      <span>{lostReasonLabel(r, lang)}</span>
                      <ShareBar fraction={share(r.count, total)} color="var(--ink-3)" />
                      <span className="mono" style={{ textAlign: "end" }}>
                        {formatCount(r.count)} · {formatRate(pct(r.count, total))}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          </SectionCard>

          <SectionCard title={tx("Reps", "مندوبو المبيعات")} section={d.reps} tx={tx} empty={(rows) => rows.length === 0}>
            {(rows) => (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ inlineSize: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "start" }}>{tx("Owner", "المسؤول")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Leads", "العملاء المحتملون")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Won", "تم الفوز")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Lost", "خسارة")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Median speed to reply", "الوسيط لسرعة الرد")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Follow-ups done", "متابعات منجزة")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Overdue", "متأخرة")}</th>
                      <th style={{ textAlign: "end" }}>{tx("Due today", "مستحقة اليوم")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const open = r.followUps.overdue + r.followUps.dueToday;
                      return (
                        <tr key={r.userId ?? `${r.former ? "former" : "none"}-${i}`}>
                          <td style={{ color: r.userId === null ? "var(--ink-3)" : undefined }}>{memberLabel(r, lang)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.leads)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.won)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.lost)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatDuration(r.medianSpeedToReplySec, lang)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.followUps.done)}</td>
                          <td className="mono" style={{ textAlign: "end" }}>
                            {r.userId && canFollowUps && open > 0 ? (
                              <a href={followUpsHref(r.userId)} title={tx("Open their follow-ups", "افتح متابعاته")}>
                                {formatCount(r.followUps.overdue)}
                              </a>
                            ) : (
                              formatCount(r.followUps.overdue)
                            )}
                          </td>
                          <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.followUps.dueToday)}</td>
                        </tr>
                      );
                    })}
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
