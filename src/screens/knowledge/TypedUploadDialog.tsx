import { useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { TypedKind } from "@/lib/types";
import { downloadTypedTemplate, uploadKnowledgeFiles } from "./knowledgeApi";
import { KB_FILE_MAX_BYTES, TYPED_KINDS } from "./knowledgeConstants";
import { errorExtra, errorKey, knowledgeErrorText, knowledgeKeyText } from "./knowledgeErrors";
import { canKeepValidRows, columnReportText, rowErrorTable, rowErrorsSummary } from "./typedErrors";

export function typedKindText(kind: TypedKind, tx: Tx): string {
  return kind === "offers" ? tx("Offers", "العروض") : kind === "inventory" ? tx("Inventory", "المخزون") : tx("Packages", "الباقات");
}

type Report = { kind: "columns" | "rows"; extra: Record<string, unknown> } | null;

/**
 * SP-21 typed spreadsheet upload (ruling 5): pick a kind, download its
 * template, upload an .xlsx or .csv. A wrong header row shows the column
 * report; bad rows show the row-error table and, when some rows are valid,
 * "Keep N valid rows" re-uploads with `acceptValidRows`.
 */
export function TypedUploadDialog({ tx, lang, onClose, onUploaded }: { tx: Tx; lang: "en" | "ar"; onClose: () => void; onUploaded: () => void }) {
  const [kind, setKind] = useState<TypedKind>("offers");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<Report>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(acceptValidRows = false) {
    if (!file) return;
    if (file.size > KB_FILE_MAX_BYTES) {
      setError(knowledgeKeyText("knowledge.file_too_large", tx, { maxBytes: KB_FILE_MAX_BYTES, fileName: file.name }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadKnowledgeFiles([file], { typedKind: kind, acceptValidRows });
      onUploaded();
      onClose();
    } catch (e) {
      const key = errorKey(e);
      if (key === "knowledge.template_columns") setReport({ kind: "columns", extra: errorExtra(e) });
      else if (key === "knowledge.typed_rows") setReport({ kind: "rows", extra: errorExtra(e) });
      else setError(knowledgeErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  async function template(k: TypedKind) {
    try {
      await downloadTypedTemplate(k);
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    }
  }

  const keep = report?.kind === "rows" ? canKeepValidRows(report.extra) : null;
  const table = report?.kind === "rows" ? rowErrorTable(report.extra, tx) : null;

  return (
    <Modal onClose={onClose} width={640} label={tx("Upload a spreadsheet", "رفع جدول بيانات")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Upload a spreadsheet", "رفع جدول بيانات")}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {tx(
            "Offers, inventory and packages use a fixed template so your assistant can answer prices and dates exactly. Required columns are green in the template.",
            "تستخدم العروض والمخزون والباقات قالبًا ثابتًا ليجيب مساعدك عن الأسعار والتواريخ بدقة. الأعمدة المطلوبة باللون الأخضر في القالب.",
          )}
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
          <span>{tx("Type", "النوع")}</span>
          <select
            style={inputStyle}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as TypedKind);
              setReport(null);
            }}
          >
            {TYPED_KINDS.map((k) => (
              <option key={k} value={k}>
                {typedKindText(k, tx)}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
          <span className="muted">{tx("Templates:", "القوالب:")}</span>
          {TYPED_KINDS.map((k) => (
            <button key={k} type="button" className="btn ghost sm" onClick={() => void template(k)}>
              {typedKindText(k, tx)} <bdi>.xlsx</bdi>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>
            {tx("Choose file", "اختر ملفًا")}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {file ? <bdi dir="auto">{file.name}</bdi> : tx("An .xlsx or .csv file", "ملف ‎.xlsx أو ‎.csv")}
          </span>
          <input
            ref={input}
            type="file"
            hidden
            accept=".xlsx,.csv"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setReport(null);
              setError(null);
              e.target.value = "";
            }}
          />
        </div>

        {report?.kind === "columns" && (
          <div role="alert" style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 12, fontSize: 13 }}>
            {(() => {
              const [e, a] = columnReportText(report.extra);
              return tx(e, a);
            })()}
          </div>
        )}
        {report?.kind === "rows" && table && (
          <div role="alert" style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13 }}>
              {(() => {
                const [e, a] = rowErrorsSummary(report.extra);
                return tx(e, a);
              })()}
            </div>
            {table.rows.length > 0 && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>{tx("Row", "الصف")}</th>
                    <th style={{ width: 140 }}>{tx("Column", "العمود")}</th>
                    <th>{tx("Problem", "المشكلة")}</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r) => (
                    <tr key={r.key}>
                      <td className="mono">
                        <bdi>{r.row}</bdi>
                      </td>
                      <td className="mono">
                        <bdi dir="ltr">{r.column}</bdi>
                      </td>
                      <td>{r.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {table.more > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>
                {tx(`And ${table.more} more.`, `و${table.more} أخرى.`)}
              </div>
            )}
          </div>
        )}
        <ErrorRow message={error} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {tx("Cancel", "إلغاء")}
          </button>
          {keep !== null && (
            <button type="button" className="btn" onClick={() => void upload(true)} disabled={busy}>
              {tx(`Keep ${keep} valid rows`, `الاحتفاظ بـ ${keep} صفًا صالحًا`)}
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => void upload(false)} disabled={busy || !file}>
            {busy ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload", "رفع")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
