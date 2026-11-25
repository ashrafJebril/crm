import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgePage, PageState } from "@/lib/types";
import { pagesPath } from "./knowledgeApi";
import { PAGE_STATES } from "./knowledgeConstants";
import { knowledgeErrorText } from "./knowledgeErrors";
import { formatWhen, PAGE_STATE_KIND, pageStateText } from "./knowledgeStatus";

/** "Blocked" has no stored reason; the HTTP status (3xx redirect, 451) helps when there is one. */
export function blockedDetail(p: Pick<KnowledgePage, "state" | "httpStatus">, tx: Tx): string | null {
  if (p.state !== "blocked") return null;
  if (p.httpStatus && p.httpStatus >= 300 && p.httpStatus < 400) return tx("Redirects off the site", "يعيد التوجيه خارج الموقع");
  if (p.httpStatus === 451) return tx("Unavailable for legal reasons (451)", "غير متاح لأسباب قانونية (451)");
  return null;
}

/** SP-21 a website's pages, filtered by state, 50 at a time. URLs are LTR in <bdi>. */
export function WebsitePages({ tx, lang, timeZone, sourceId, title, onClose }: { tx: Tx; lang: "en" | "ar"; timeZone?: string; sourceId: string; title: string; onClose: () => void }) {
  const [state, setState] = useState<PageState | "">("");
  const [items, setItems] = useState<KnowledgePage[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(cursor?: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ items: KnowledgePage[]; nextCursor: string | null }>(pagesPath(sourceId, state || undefined, cursor));
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNext(res.nextCursor);
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sourceId]);

  return (
    <Modal onClose={onClose} width={760} label={tx("Website pages", "صفحات الموقع")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12, maxHeight: "78vh", overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Website pages", "صفحات الموقع")}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              <bdi dir="ltr">{title}</bdi>
            </div>
          </div>
          <select style={{ ...inputStyle, width: 200 }} value={state} aria-label={tx("Filter by state", "التصفية حسب الحالة")} onChange={(e) => setState(e.target.value as PageState | "")}>
            <option value="">{tx("All pages", "كل الصفحات")}</option>
            {PAGE_STATES.map((s) => (
              <option key={s} value={s}>
                {pageStateText(s, tx)}
              </option>
            ))}
          </select>
        </div>
        <ErrorRow message={error} />
        <table className="tbl">
          <thead>
            <tr>
              <th>{tx("Page", "الصفحة")}</th>
              <th>{tx("State", "الحالة")}</th>
              <th>{tx("Last read", "آخر قراءة")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={3} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  {tx("No pages.", "لا توجد صفحات.")}
                </td>
              </tr>
            )}
            {items.map((p) => (
              <tr key={p.id}>
                <td style={{ maxWidth: 380 }}>
                  {p.title && (
                    <div dir="auto" style={{ fontWeight: 500, textAlign: "start" }}>
                      {p.title}
                    </div>
                  )}
                  <div className="mono muted" style={{ fontSize: 11, overflowWrap: "anywhere" }}>
                    <bdi dir="ltr">{p.url}</bdi>
                  </div>
                </td>
                <td>
                  <Badge kind={PAGE_STATE_KIND[p.state]} dot>
                    {pageStateText(p.state, tx)}
                  </Badge>
                  {p.httpStatus && p.state !== "synced" && (
                    <span className="mono muted" style={{ fontSize: 11, marginInlineStart: 6 }}>
                      <bdi>{p.httpStatus}</bdi>
                    </span>
                  )}
                  {blockedDetail(p, tx) && <div className="muted" style={{ fontSize: 11 }}>{blockedDetail(p, tx)}</div>}
                </td>
                <td className="mono muted" style={{ fontSize: 12 }}>
                  {p.state === "removed" ? formatWhen(p.removedAt, lang, timeZone) : formatWhen(p.lastReadAt, lang, timeZone)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {next && (
            <button type="button" className="btn" onClick={() => void load(next)} disabled={loading}>
              {tx("Load more", "تحميل المزيد")}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {tx("Close", "إغلاق")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
