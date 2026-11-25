import { useEffect, useRef, useState } from "react";
import type { Tx } from "@/lib/tx";
import { errorsToCsv } from "./importMapping";
import { messageText } from "./importMessages";
import { cancelImport, getImport, saveBlob, type ImportJob } from "./importApi";
import { ErrorTable, Stat } from "./StepPreview";
import { ERROR_BOX } from "./styles";

export const POLL_MS = 1500;
const TERMINAL = new Set(["done", "failed", "cancelled"]);

export function pct(job: Pick<ImportJob, "processed" | "totalRows">): number {
  return job.totalRows > 0 ? Math.min(100, Math.floor((job.processed / job.totalRows) * 100)) : 0;
}

/** Polls GET /imports/:id every 1.5 s until the job reaches a terminal state. */
export function useImportJob(jobId: string | null, onTerminal?: (j: ImportJob) => void) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [failed, setFailed] = useState(false);
  const cb = useRef(onTerminal);
  cb.current = onTerminal;
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: number | undefined;
    const ctl = new AbortController();
    const tick = async () => {
      try {
        const j = await getImport(jobId, ctl.signal);
        if (stop) return;
        setJob(j);
        setFailed(false);
        if (TERMINAL.has(j.status)) { cb.current?.(j); return; }
      } catch {
        if (stop) return;
        setFailed(true); // keep polling: a blip must not strand the UI
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stop = true; ctl.abort(); window.clearTimeout(timer); };
  }, [jobId]);
  return { job, pollFailed: failed };
}

interface Props {
  tx: Tx;
  jobId: string;
  onStatus: (s: ImportJob["status"]) => void;
  onViewContacts: () => void;
  onClose: () => void;
}

export function StepRun({ tx, jobId, onStatus, onViewContacts, onClose }: Props) {
  const { job, pollFailed } = useImportJob(jobId);
  const status = job?.status;
  useEffect(() => { if (status) onStatus(status); }, [status, onStatus]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  if (!job) return <div className="muted" style={{ fontSize: 13 }}>{tx("Starting…", "جارٍ البدء…")}</div>;
  const terminal = TERMINAL.has(job.status);
  const p = terminal && job.status === "done" ? 100 : pct(job);

  const cancel = async () => {
    setCancelling(true);
    setCancelErr(null);
    try { await cancelImport(jobId); } catch (e) { setCancelErr(e instanceof Error ? messageText(e.message, tx) : null); }
    finally { setCancelling(false); }
  };
  const downloadErrors = () => {
    const rows = job.errors.map((e) => ({ row: e.row, column: e.column, reason: messageText(e.key, tx) }));
    saveBlob(
      new Blob([errorsToCsv(rows, [tx("Row", "الصف"), tx("Column", "العمود"), tx("Problem", "المشكلة")])], { type: "text/csv;charset=utf-8" }),
      "import-errors.csv",
    );
  };

  const title =
    job.status === "done" ? tx("Import finished", "اكتمل الاستيراد")
    : job.status === "failed" ? tx("Import failed", "فشل الاستيراد")
    : job.status === "cancelled" ? tx("Import cancelled", "أُلغي الاستيراد")
    : tx("Importing…", "جارٍ الاستيراد…");

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div>
      <div>
        <div
          role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}
          style={{ height: 8, borderRadius: 999, background: "var(--bg-2)", overflow: "hidden" }}
        >
          <div style={{ width: `${p}%`, height: "100%", background: job.status === "failed" ? "var(--bad)" : "var(--accent)", transition: "width .3s" }} />
        </div>
        <div className="muted mono" style={{ fontSize: 11, marginBlockStart: 4 }}>
          {job.processed.toLocaleString()} / {job.totalRows.toLocaleString()} · {p}%
        </div>
      </div>
      {pollFailed && !terminal && <div className="muted" style={{ fontSize: 12 }}>{tx("Reconnecting…", "جارٍ إعادة الاتصال…")}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 8 }}>
        <Stat label={tx("Created", "أُنشئت")} value={job.created} tone="var(--ok)" />
        <Stat label={tx("Updated", "حُدّثت")} value={job.updated} />
        <Stat label={tx("Skipped", "تُخطّيت")} value={job.skipped + job.duplicateInFile} />
        <Stat label={tx("Failed", "فشلت")} value={job.failed} tone={job.failed ? "var(--bad)" : undefined} />
      </div>

      {job.errors.length > 0 && terminal && <ErrorTable tx={tx} rows={job.errors} />}
      {cancelErr && <div role="alert" style={ERROR_BOX}>{cancelErr}</div>}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {!terminal && (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>{tx("Close (keeps running)", "إغلاق (يستمر في الخلفية)")}</button>
            <button type="button" className="btn" disabled={cancelling} onClick={cancel}>{tx("Cancel import", "إلغاء الاستيراد")}</button>
          </>
        )}
        {terminal && job.errors.length > 0 && (
          <button type="button" className="btn" onClick={downloadErrors}>{tx("Download errors as CSV", "تنزيل الأخطاء كملف CSV")}</button>
        )}
        {terminal && (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>{tx("Close", "إغلاق")}</button>
            <button type="button" className="btn primary" onClick={onViewContacts}>
              {job.kind === "audience" ? tx("View groups", "عرض المجموعات") : tx("View contacts", "عرض جهات الاتصال")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
