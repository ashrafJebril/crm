import type { Tx } from "@/lib/tx";
import type { CampaignInsights, RecipientStatus } from "@/lib/types";
import { barPct } from "./campaignDetailModel";
import { failureLabel, unrecordedLabel } from "./failureCodes";
import { Card, HBars, fmtNum, type BarRow } from "./ui";
import type { CustomLabels } from "./varMap";

interface Props {
  failures: CampaignInsights["failures"];
  unrecorded: number;
  tx: Tx;
  /** Opens the table filtered to the outcome that line belongs to. */
  onPick: (status: Extract<RecipientStatus, "failed" | "skipped">) => void;
  /** SP-13: custom field labels for `skip:missing_value:custom.*`. */
  customLabels?: CustomLabels;
}

/** Why people did not get it: bilingual reason per code, warning hue, each line opens the table. */
export function FailureReasonsCard({ failures, unrecorded, tx, onPick, customLabels }: Props) {
  const title = tx("Failure reasons", "أسباب الفشل");
  const total = failures.reduce((a, f) => a + f.count, 0) + unrecorded;
  if (total === 0) {
    return (
      <Card title={title}>
        <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{tx("Nothing failed or was left out.", "لم يفشل أي إرسال ولم يُستبعد أحد.")}</div>
      </Card>
    );
  }
  const max = Math.max(unrecorded, ...failures.map((f) => f.count));
  const rows: BarRow[] = failures.map((f) => {
    const status = f.code.startsWith("skip:") ? "skipped" : "failed";
    const label = failureLabel(f.code, f.title, tx, customLabels);
    return {
      key: f.code,
      label,
      labelText: label,
      count: f.count,
      barPct: barPct(f.count, max),
      onClick: () => onPick(status),
      clickHint:
        status === "skipped"
          ? tx("Show skipped recipients", "عرض المستلمين المستبعدين")
          : tx("Show failed recipients", "عرض المستلمين الذين فشل الإرسال إليهم"),
    };
  });
  if (unrecorded > 0) {
    rows.push({
      key: "__unrecorded",
      label: unrecordedLabel(tx),
      labelText: unrecordedLabel(tx),
      count: unrecorded,
      barPct: barPct(unrecorded, max),
    });
  }
  const aria = `${title}: ` + rows.map((r) => `${r.labelText} ${fmtNum(r.count)}`).join(", ");
  return (
    <Card title={title} sub={tx(`${fmtNum(total)} not delivered or left out`, `${fmtNum(total)} لم تصل أو مستبعدة`)}>
      <HBars rows={rows} ariaLabel={aria} color="var(--warn)" headers={[tx("Reason", "السبب"), tx("People", "الأشخاص")]} />
    </Card>
  );
}
