import type { Tx } from "@/lib/tx";
import type { ReadTiming } from "@/lib/types";
import { readTimingLabel, readTimingShares } from "./campaignDetailModel";
import { Card, HBars, fmtNum } from "./ui";

/** How long after sending people read it: four buckets whose shares sum to 100. Same hue as the funnel (one series). */
export function ReadTimeCard({ timing, tx }: { timing: ReadTiming; tx: Tx }) {
  const shares = readTimingShares(timing);
  const title = tx("Time to read", "وقت القراءة");
  if (!shares) {
    return (
      <Card title={title}>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{tx("No reads yet.", "لا توجد قراءات بعد.")}</div>
      </Card>
    );
  }
  const rows = shares.map((s) => ({
    key: s.key,
    label: readTimingLabel(s.key, tx),
    labelText: readTimingLabel(s.key, tx),
    count: s.count,
    barPct: s.pct,
    pctText: `${s.pct}%`,
  }));
  const aria = `${title}: ` + rows.map((r) => `${r.labelText} ${fmtNum(r.count)} (${r.pctText})`).join(", ");
  return (
    <Card title={title} sub={tx("After the message was sent", "بعد إرسال الرسالة")}>
      <HBars
        rows={rows}
        ariaLabel={aria}
        headers={[tx("Read", "القراءة"), tx("People", "الأشخاص"), tx("Share", "النسبة")]}
      />
    </Card>
  );
}
