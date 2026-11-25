import type { Tx } from "@/lib/tx";
import type { CampaignInsights } from "@/lib/types";
import { barPct, replyLines } from "./campaignDetailModel";
import { Card, HBars, fmtNum } from "./ui";

/** Replies: one line per button (label or payload), typed replies last. */
export function ReplySummaryCard({ replies, tx }: { replies: CampaignInsights["replies"]; tx: Tx }) {
  const title = tx("Replies", "الردود");
  const lines = replyLines(replies, tx);
  if (lines.length === 0) {
    return (
      <Card title={title}>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{tx("No replies yet.", "لا توجد ردود بعد.")}</div>
      </Card>
    );
  }
  const max = Math.max(...lines.map((l) => l.count));
  const total = lines.reduce((a, l) => a + l.count, 0);
  const rows = lines.map((l, i) => ({
    key: l.typed ? "__typed" : `b${i}`,
    label: l.typed ? <em style={{ fontStyle: "normal", color: "var(--ink-3)" }}>{l.text}</em> : l.text,
    labelText: l.text,
    count: l.count,
    barPct: barPct(l.count, max),
  }));
  const aria = `${title}: ` + rows.map((r) => `${r.labelText} ${fmtNum(r.count)}`).join(", ");
  return (
    <Card title={title} sub={tx(`${fmtNum(total)} replied`, `${fmtNum(total)} ردّوا`)}>
      <HBars rows={rows} ariaLabel={aria} labelDir="auto" headers={[tx("Reply", "الرد"), tx("People", "الأشخاص")]} />
    </Card>
  );
}
