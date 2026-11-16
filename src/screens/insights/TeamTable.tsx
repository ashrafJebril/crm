import type { Lang } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { SectionCard } from "./InsightsUi";
import { formatCount, formatDay, formatDuration, memberLabel } from "./insightsModel";
import type { Section, TeamRow } from "./insightsTypes";

/** Support's Team sub-tab: one row per member; replies before attribution began are "Unattributed". */
export function TeamTable({
  section,
  attributionSince,
  lang,
  tx,
}: {
  section: Section<TeamRow[]> | undefined;
  /** From the server; null hides the attribution note. */
  attributionSince: string | null;
  lang: Lang;
  tx: Tx;
}) {
  const since = attributionSince ? formatDay(attributionSince, lang) : null;
  return (
    <SectionCard
      title={tx("Team", "الفريق")}
      sub={since ? tx(`Replies are credited to their sender since ${since}`, `تُنسب الردود إلى مُرسلها منذ ${since}`) : undefined}
      section={section}
      tx={tx}
      empty={(rows) => rows.length === 0}
    >
      {(rows) => (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl" style={{ inlineSize: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "start" }}>{tx("Member", "العضو")}</th>
                <th style={{ textAlign: "end" }}>{tx("Assigned", "المُسندة")}</th>
                <th style={{ textAlign: "end" }}>{tx("Replies", "الردود")}</th>
                <th style={{ textAlign: "end" }}>{tx("Median first response", "الوسيط لأول رد")}</th>
                <th style={{ textAlign: "end" }}>{tx("Resolved", "المحلولة")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const unattributed = r.userId === null && !r.former;
                return (
                  <tr key={r.userId ?? `${r.former ? "former" : "unattributed"}-${i}`}>
                    <td>
                      <span style={{ color: r.userId === null ? "var(--ink-3)" : undefined }}>{memberLabel(r, lang)}</span>
                      {unattributed && since && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {tx(`Replies from before ${since}, or not sent by a member`, `ردود قبل ${since} أو لم يرسلها عضو`)}
                        </div>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.assigned)}</td>
                    <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.replies)}</td>
                    <td className="mono" style={{ textAlign: "end" }}>{formatDuration(r.medianFirstResponseSec, lang)}</td>
                    <td className="mono" style={{ textAlign: "end" }}>{formatCount(r.resolved)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
