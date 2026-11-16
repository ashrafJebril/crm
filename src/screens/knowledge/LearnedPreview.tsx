import { useFetch } from "@/api/useFetch";
import { Modal } from "@/components/Modal";
import { ErrorRow } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgePreview } from "@/lib/types";
import { previewPath } from "./knowledgeApi";
import { PREVIEW_MAX_ITEMS } from "./knowledgeConstants";
import { knowledgeErrorText } from "./knowledgeErrors";

/**
 * "What your assistant learned": the source's searchable passages grouped by
 * sheet or section (else "General"). The text is shown as plain text, never as
 * HTML; row numbers and URLs sit in <bdi>.
 */
export function LearnedPreview({ tx, sourceId, title, onClose, lang }: { tx: Tx; sourceId: string; title: string; onClose: () => void; lang: "en" | "ar" }) {
  const q = useFetch<KnowledgePreview>(previewPath(sourceId));
  const groups = q.data?.groups ?? [];
  return (
    <Modal onClose={onClose} width={720} label={tx("What your assistant learned", "ما تعلّمه مساعدك")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12, maxHeight: "75vh", overflowY: "auto" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("What your assistant learned", "ما تعلّمه مساعدك")}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            <bdi>{title}</bdi>
          </div>
        </div>
        <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
        {q.loading && !q.data && <div className="muted mono pulse" style={{ fontSize: 12 }}>{tx("loading…", "جارٍ التحميل…")}</div>}
        {q.data && groups.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>{tx("Nothing yet. The assistant has no passages from this source.", "لا شيء بعد. لا توجد لدى المساعد مقاطع من هذا المصدر.")}</div>
        )}
        {groups.map((g, gi) => (
          <details key={`${g.heading ?? "general"}-${gi}`} open={gi === 0} style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: "8px 12px" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
              <bdi dir="auto">{g.heading ?? tx("General", "عام")}</bdi> <span className="muted mono" style={{ fontSize: 11 }}>({g.items.length})</span>
            </summary>
            <ol style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "grid", gap: 6 }}>
              {g.items.map((it) => (
                <li key={it.chunkId} style={{ fontSize: 12, borderTop: "1px solid var(--line-soft)", paddingTop: 6 }}>
                  {it.rowRef !== null && (
                    <span className="mono muted" style={{ fontSize: 11, marginInlineEnd: 6 }}>
                      {tx("Row", "الصف")} <bdi>{it.rowRef}</bdi>
                    </span>
                  )}
                  {it.url && (
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      <bdi dir="ltr">{it.url}</bdi>
                    </div>
                  )}
                  <div dir="auto" style={{ whiteSpace: "pre-wrap", textAlign: "start" }}>
                    {it.text}
                  </div>
                </li>
              ))}
            </ol>
          </details>
        ))}
        {q.data?.truncated && (
          <div className="muted" style={{ fontSize: 12 }}>
            {tx(`Showing the first ${PREVIEW_MAX_ITEMS} passages.`, `عرض أول ${PREVIEW_MAX_ITEMS} مقطع.`)}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Close", "إغلاق")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
