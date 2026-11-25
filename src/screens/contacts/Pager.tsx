import type { Tx } from "@/lib/tx";
import { IconChev } from "@/icons";
import { pageWindow, rangeLabel } from "./paging";

const PAGE_SIZES = [25, 50, 100];

/** Footer under the contacts table: range, page buttons and page size. */
export function Pager({
  tx,
  page,
  pageCount,
  pageSize,
  total,
  onPage,
  onPageSize,
  busy,
}: {
  tx: Tx;
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
  busy?: boolean;
}) {
  const r = rangeLabel(page, pageSize, total);
  return (
    <nav
      aria-label={tx("Contacts pages", "صفحات جهات الاتصال")}
      style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 4px", fontSize: 12.5 }}
    >
      <span className="muted" aria-live="polite">
        {total === 0
          ? tx("No contacts", "لا توجد جهات اتصال")
          : tx(
              `${r.from.toLocaleString()}–${r.to.toLocaleString()} of ${r.total.toLocaleString()}`,
              `${r.from.toLocaleString()}–${r.to.toLocaleString()} من ${r.total.toLocaleString()}`,
            )}
        {busy && <span style={{ marginInlineStart: 8 }}>· {tx("loading…", "جارٍ التحميل…")}</span>}
      </span>
      <span style={{ flex: 1 }} />
      <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {tx("Rows", "صفوف")}
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          style={{ height: 28, borderRadius: 6, background: "var(--bg-1)", border: "1px solid var(--line-soft)", color: "var(--ink)" }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          type="button"
          className="btn sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label={tx("Previous page", "الصفحة السابقة")}
        >
          <span className="flip-rtl" style={{ display: "inline-flex" }}>
            <span style={{ display: "inline-flex", transform: "rotate(180deg)" }}>
              <IconChev w={12} />
            </span>
          </span>
        </button>
        {pageWindow(page, pageCount).map((p, i) =>
          p === "gap" ? (
            <span key={`gap-${i}`} className="muted" style={{ padding: "0 4px" }}>
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`btn sm${p === page ? " primary" : " ghost"}`}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPage(p)}
              style={{ minWidth: 28, justifyContent: "center" }}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="btn sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          aria-label={tx("Next page", "الصفحة التالية")}
        >
          <span className="flip-rtl" style={{ display: "inline-flex" }}>
            <IconChev w={12} />
          </span>
        </button>
      </div>
    </nav>
  );
}
