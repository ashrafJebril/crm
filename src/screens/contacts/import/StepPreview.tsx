import type { Tx } from "@/lib/tx";
import { messageText } from "./importMessages";
import type { ImportPreview } from "./importApi";

export function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: "8px 12px", minWidth: 0 }}>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color: tone }}>{value.toLocaleString()}</div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
    </div>
  );
}

export function ErrorTable({ tx, rows }: { tx: Tx; rows: { row: number; column: string | null; key: string }[] }) {
  return (
    <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, maxHeight: 220, overflow: "auto" }}>
      <table className="tbl" style={{ fontSize: 12 }}>
        <thead>
          <tr><th>{tx("Row", "الصف")}</th><th>{tx("Column", "العمود")}</th><th>{tx("Problem", "المشكلة")}</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.row}-${i}`}>
              <td className="mono">{r.row > 0 ? r.row : "—"}</td>
              <td dir="auto">{r.column ?? "—"}</td>
              <td>{messageText(r.key, tx)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StepPreview({ tx, preview, updateExisting }: { tx: Tx; preview: ImportPreview; updateExisting: boolean }) {
  const c = preview.counts;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
        <Stat label={tx("New contacts", "جهات جديدة")} value={c.new} tone="var(--ok)" />
        <Stat label={updateExisting ? tx("Will update", "سيتم تحديثها") : tx("Already exist", "موجودة مسبقًا")} value={c.update + c.unchanged} />
        <Stat label={tx("Duplicates in file", "مكررة في الملف")} value={c.duplicateInFile} />
        <Stat label={tx("Invalid rows", "صفوف غير صالحة")} value={c.invalid} tone={c.invalid ? "var(--bad)" : undefined} />
      </div>
      {!updateExisting && c.unchanged > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>
          {tx("Existing contacts are left unchanged because “Update existing contacts” is off.", "تُترك الجهات الموجودة دون تغيير لأن خيار «تحديث الجهات الموجودة» متوقف.")}
        </div>
      )}
      {preview.invalidSamples.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBlockEnd: 6 }}>
            {tx(`Invalid rows (first ${preview.invalidSamples.length})`, `الصفوف غير الصالحة (أول ${preview.invalidSamples.length})`)}
          </div>
          <ErrorTable tx={tx} rows={preview.invalidSamples} />
        </div>
      )}
    </div>
  );
}
