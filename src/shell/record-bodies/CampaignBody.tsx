import { makeTx } from "@/lib/tx";
import { FieldList } from "./FieldList";
import { fieldLabel } from "../recordFields";
import type { RecordBodyProps } from "../RecordSheet";

const STATS = ["sent", "delivered", "read", "failed"] as const;

export function CampaignBody({ summary, lang }: RecordBodyProps) {
  const tx = makeTx(lang);
  const num = (k: string): number => {
    const v = summary.fields.find((f) => f.key === k)?.value;
    return typeof v === "number" ? v : 0;
  };
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "16px 20px 24px" }}>
      <FieldList kind="campaign" fields={summary.fields.filter((f) => !(STATS as readonly string[]).includes(f.key))} lang={lang} />
      <div className="mono" style={{ marginTop: 22, marginBottom: 8, fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
        {tx("Results", "النتائج")}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {STATS.map((k) => (
          <div key={k} style={{ background: "var(--bg-2)", border: "1px solid var(--line-soft)", borderRadius: 8, padding: "8px 10px" }}>
            <div className="mono" style={{ fontSize: 9, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
              {fieldLabel(k, lang)}
            </div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>
              {num(k).toLocaleString(lang === "ar" ? "ar" : "en-US")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
