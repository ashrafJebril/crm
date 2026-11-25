import { useRef, useState, type DragEvent } from "react";
import type { Tx } from "@/lib/tx";
import { ERROR_BOX } from "./styles";

export const MAX_BYTES = 10 * 1024 * 1024;

/** Client-side mirror of the server's file checks; returns a message or null. */
export function checkFile(file: File, tx: Tx): string | null {
  if (!/\.(csv|xlsx)$/i.test(file.name)) return tx("Only .csv and .xlsx files are supported.", "الملفات المدعومة هي csv و xlsx فقط.");
  if (file.size === 0) return tx("The file is empty.", "الملف فارغ.");
  if (file.size > MAX_BYTES) return tx("The file is larger than 10 MB.", "حجم الملف أكبر من 10 ميغابايت.");
  return null;
}

interface Props {
  tx: Tx;
  busy: boolean;
  error: string | null;
  onFile: (file: File) => void;
}

export function StepUpload({ tx, busy, error, onFile }: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const take = (file: File | undefined) => {
    if (!file) return;
    const problem = checkFile(file, tx);
    setLocalError(problem);
    if (!problem) onFile(file);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (!busy) take(e.dataTransfer.files[0]);
  };
  const shown = localError ?? error;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div
        role="button"
        tabIndex={0}
        aria-disabled={busy}
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !busy) { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${over ? "var(--accent)" : "var(--line)"}`,
          background: over ? "var(--accent-soft)" : "transparent",
          borderRadius: 12, padding: "36px 16px", textAlign: "center", cursor: busy ? "default" : "pointer",
          color: "var(--ink-2)", fontSize: 13, display: "grid", gap: 6,
        }}
      >
        <strong style={{ fontSize: 14 }}>
          {busy ? tx("Uploading…", "جارٍ الرفع…") : tx("Drop a file here, or click to choose", "أفلت ملفًا هنا، أو انقر للاختيار")}
        </strong>
        <span className="muted" style={{ fontSize: 12 }}>
          {tx("CSV or XLSX, up to 10 MB and 50,000 rows. The first row must be the column headers.", "ملف CSV أو XLSX حتى 10 ميغابايت و50,000 صف. يجب أن يكون الصف الأول عناوين الأعمدة.")}
        </span>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }}
      />
      {shown && <div role="alert" style={ERROR_BOX}>{shown}</div>}
    </div>
  );
}
