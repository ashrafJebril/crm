import type { Tx } from "@/lib/tx";
import type { CampaignFunnel as Funnel } from "@/lib/types";
import { formatPct, funnelLabel, funnelSteps } from "./campaignDetailModel";
import { Card, HBars, fmtNum } from "./ui";

/** Targeted → attempted (sent + failed) → delivered → read → replied, each as a share of targeted. One accent hue. */
export function CampaignFunnel({ funnel, tx }: { funnel: Funnel; tx: Tx }) {
  const steps = funnelSteps({ funnel });
  const rows = steps.map((s) => ({
    key: s.key,
    label: funnelLabel(s.key, tx),
    labelText: funnelLabel(s.key, tx),
    count: s.count,
    barPct: s.pct ?? 0,
    pctText: s.pct === null ? undefined : formatPct(s.pct),
  }));
  const aria =
    tx("Funnel", "مسار الحملة") +
    ": " +
    rows.map((r) => `${r.labelText} ${fmtNum(r.count)}${r.pctText ? ` (${r.pctText})` : ""}`).join(", ");
  return (
    <Card title={tx("Funnel", "مسار الحملة")} sub={tx("Share of everyone targeted", "النسبة من كل المستهدفين")}>
      <HBars
        rows={rows}
        ariaLabel={aria}
        headers={[tx("Step", "المرحلة"), tx("People", "الأشخاص"), tx("Share of targeted", "النسبة من المستهدفين")]}
      />
    </Card>
  );
}
