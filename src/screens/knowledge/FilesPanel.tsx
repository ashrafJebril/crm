import { useRef, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { Badge } from "@/components/Badge";
import { useToast } from "@/components/Toast";
import { ErrorRow } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgeSource } from "@/lib/types";
import { deleteSource, downloadSourceFile, reprocessSource, SOURCES_PATH, uploadKnowledgeFiles, type SourceList } from "./knowledgeApi";
import { KB_ACCEPT, KB_BATCH_MAX, KB_FILE_MAX_BYTES, KNOWLEDGE_POLL_MS } from "./knowledgeConstants";
import { knowledgeErrorText, knowledgeKeyText } from "./knowledgeErrors";
import { BADGE_KIND, badgeText, formatBytes, formatWhen, retryNote, shouldPoll, sourceBadge } from "./knowledgeStatus";
import { checkBatch } from "./fileCheck";
import { LearnedPreview } from "./LearnedPreview";
import { TypedUploadDialog, typedKindText } from "./TypedUploadDialog";

const isFileKind = (s: KnowledgeSource) => s.kind === "file" || s.kind === "typed_doc";

/**
 * SP-21 files and spreadsheets: batch upload (≤ 10 files, ≤ 20 MB each,
 * checked before sending), typed spreadsheets through their dialog, status
 * pills polled every 5 s while any file is queued or processing, preview,
 * download, reprocess and delete. Migrated l documents are marked and have no
 * stored file.
 */
export function FilesPanel({
  tx,
  lang,
  timeZone,
  canCreate,
  canEdit,
  canDelete,
}: {
  tx: Tx;
  lang: "en" | "ar";
  timeZone?: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const { toast } = useToast();
  const q = useFetch<SourceList>(SOURCES_PATH, {
    pollMs: (d) => (shouldPoll((d?.items ?? []).filter(isFileKind)) ? KNOWLEDGE_POLL_MS : null),
  });
  const files = (q.data?.items ?? []).filter(isFileKind);
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedOpen, setTypedOpen] = useState(false);
  const [preview, setPreview] = useState<KnowledgeSource | null>(null);

  async function onPick(list: FileList | null) {
    const picked = list ? Array.from(list) : [];
    if (picked.length === 0) return;
    setError(null);
    const bad = checkBatch(picked);
    if (bad) {
      setError(knowledgeKeyText(bad.key, tx, bad.extra));
      return;
    }
    setUploading(true);
    try {
      await uploadKnowledgeFiles(picked);
      await q.refetch();
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setUploading(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      toast(knowledgeErrorText(e, tx), "error", e);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="muted" style={{ fontSize: 13, maxWidth: 820 }}>
        {tx(
          `PDF, Excel (.xlsx), CSV and JPEG, PNG or WebP images, up to ${formatBytes(KB_FILE_MAX_BYTES)} each and ${KB_BATCH_MAX} at a time. Scanned PDFs and images are read automatically.`,
          `ملفات PDF وExcel (‎.xlsx) وCSV وصور JPEG أو PNG أو WebP، حتى ${formatBytes(KB_FILE_MAX_BYTES)} لكل ملف و${KB_BATCH_MAX} ملفات في كل مرة. تُقرأ ملفات PDF الممسوحة والصور تلقائيًا.`,
        )}
      </div>
      {canCreate && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn primary" onClick={() => input.current?.click()} disabled={uploading}>
            {uploading ? tx("Uploading…", "جارٍ الرفع…") : tx("Upload files", "رفع ملفات")}
          </button>
          <button type="button" className="btn" onClick={() => setTypedOpen(true)}>
            {tx("Upload offers, inventory or packages", "رفع العروض أو المخزون أو الباقات")}
          </button>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={KB_ACCEPT}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
      <ErrorRow message={error} />

      <table className="tbl">
        <thead>
          <tr>
            <th>{tx("File", "الملف")}</th>
            <th>{tx("Type", "النوع")}</th>
            <th>{tx("Status", "الحالة")}</th>
            <th>{tx("Passages", "المقاطع")}</th>
            <th>{tx("Added", "أُضيف")}</th>
            <th aria-label={tx("Actions", "الإجراءات")} />
          </tr>
        </thead>
        <tbody>
          {files.length === 0 && (
            <tr>
              <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>
                {q.loading ? tx("loading…", "جارٍ التحميل…") : tx("No files yet.", "لا توجد ملفات بعد.")}
              </td>
            </tr>
          )}
          {files.map((s) => {
            const badge = sourceBadge(s);
            const note = retryNote(s, tx);
            const err = s.status === "failed" ? knowledgeKeyText(s.error, tx) : null;
            return (
              <tr key={s.id}>
                <td style={{ maxWidth: 280 }}>
                  <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>
                    <bdi dir="auto">{s.file?.fileName ?? s.title}</bdi>
                  </div>
                  {s.file && <div className="muted mono" style={{ fontSize: 11 }}>{formatBytes(s.file.sizeBytes)}</div>}
                  {s.legacy && !s.file && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {tx("Moved from the previous knowledge list. Upload the file again to make it searchable.", "نُقل من قائمة المعرفة السابقة. ارفع الملف مجددًا ليصبح قابلًا للبحث.")}
                    </div>
                  )}
                </td>
                <td>{s.typedKind ? typedKindText(s.typedKind, tx) : tx("File", "ملف")}</td>
                <td>
                  <Badge kind={BADGE_KIND[badge]} dot>
                    {badgeText(badge, tx)}
                  </Badge>
                  {err && <div style={{ fontSize: 11, color: "var(--bad)", marginTop: 4, maxWidth: 260 }}>{err}</div>}
                  {note && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{note}</div>}
                </td>
                <td className="mono">
                  <bdi>{s.itemCount}</bdi>
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {formatWhen(s.createdAt, lang, timeZone)}
                </td>
                <td>
                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {s.status === "ready" && (
                      <button type="button" className="btn ghost sm" onClick={() => setPreview(s)}>
                        {tx("What it learned", "ما تعلّمه")}
                      </button>
                    )}
                    {s.file && (
                      <button type="button" className="btn ghost sm" onClick={() => void act(() => downloadSourceFile(s.id, s.file!.fileName))}>
                        {tx("Download", "تنزيل")}
                      </button>
                    )}
                    {canEdit && s.file && (s.status === "failed" || s.status === "ready") && (
                      <button type="button" className="btn ghost sm" onClick={() => void act(() => reprocessSource(s.id))}>
                        {tx("Process again", "إعادة المعالجة")}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => {
                          if (window.confirm(tx(`Delete "${s.title}"? The assistant will stop using it.`, `حذف "${s.title}"؟ سيتوقف المساعد عن استخدامه.`))) void act(() => deleteSource(s.id));
                        }}
                      >
                        {tx("Delete", "حذف")}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {typedOpen && <TypedUploadDialog tx={tx} lang={lang} onClose={() => setTypedOpen(false)} onUploaded={() => void q.refetch()} />}
      {preview && <LearnedPreview tx={tx} lang={lang} sourceId={preview.id} title={preview.title} onClose={() => setPreview(null)} />}
    </div>
  );
}
