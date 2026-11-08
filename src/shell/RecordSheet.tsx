import { useEffect, useId, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/api/client";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { openRecord } from "@/lib/openRecord";
import { anotherModalOpen } from "@/lib/modalOpen";
import type { RecordKind, RecordRef } from "@/lib/recordParam";
import type { Lang } from "@/lib/types";
import { displaySubtitle, formatDate, kindLabel, type FieldValue } from "./recordFields";
import { ContactBody } from "./record-bodies/ContactBody";
import { TicketBody } from "./record-bodies/TicketBody";
import { ConversationBody } from "./record-bodies/ConversationBody";
import { BookingBody } from "./record-bodies/BookingBody";
import { CampaignBody } from "./record-bodies/CampaignBody";

export interface RecordLinkItem {
  kind: RecordKind;
  id: string;
  title: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  /** Optional ISO timestamp (lets conversation chips be told apart). */
  updatedAt?: string;
}

/** GET /records/:kind/:id */
export interface RecordSummary {
  kind: RecordKind;
  id: string;
  title: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  fields: { key: string; value: FieldValue }[];
  links: RecordLinkItem[];
}

export interface RecordBodyProps {
  summary: RecordSummary;
  lang: Lang;
  /** Close the sheet (no history entry). */
  onClose: () => void;
  /** The record was edited: refresh the page behind and the sheet header. */
  onChanged: () => void;
  /** The record was deleted: close the sheet and refresh the page behind. */
  onDeleted: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const pick = (lang: Lang, en?: string, ar?: string): string => (lang === "ar" && ar ? ar : (en ?? ""));

function Body(props: RecordBodyProps) {
  switch (props.summary.kind) {
    case "contact":
      return <ContactBody {...props} />;
    case "ticket":
      return <TicketBody {...props} />;
    case "conversation":
      return <ConversationBody {...props} />;
    case "booking":
      return <BookingBody {...props} />;
    case "campaign":
      return <CampaignBody {...props} />;
  }
}

/** The sheet frame: header (kind, title, subtitle, close), related-record chips,
 *  the per-kind body, plus the loading and "not available" states. It is a modal
 *  dialog: focus moves in, Tab stays inside, Escape closes. */
export function RecordSheet({
  rec,
  onClose,
  onChanged,
  onDeleted,
}: {
  rec: RecordRef;
  onClose: () => void;
  onChanged: (rec: RecordRef) => void;
  onDeleted: (rec: RecordRef) => void;
}) {
  const { t } = useTweaks();
  const lang = t.lang;
  const tx = makeTx(lang);
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);

  const q = useQuery<RecordSummary, Error>({
    queryKey: ["record", rec.kind, rec.id],
    queryFn: ({ signal }) =>
      api.get<RecordSummary>(`/records/${rec.kind}/${encodeURIComponent(rec.id)}`, signal),
    // A 404 is an answer (not openable / missing), not a transient failure.
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 1,
  });
  const s = q.data;
  const notFound = q.error instanceof ApiError && q.error.status === 404;

  // Focus into the sheet on open.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Keys inside the sheet: handled here (React) so inner handlers such as the
  // mention list, which stop propagation, win over the sheet. Escape closes;
  // Tab is trapped. Everything else is kept from window-level screen shortcuts.
  // Keys from a dialog stacked above the sheet (delete confirm) are left alone.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const inner = e.target instanceof Element ? e.target.closest('[aria-modal="true"]') : null;
    if (inner && inner !== panel) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const els = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (els.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Fallback: focus is outside the panel (e.g. on the body), so React never sees
  // the key. Close on Escape unless a stacked dialog should take it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      if (anotherModalOpen(panel)) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const title = s ? pick(lang, s.title, s.titleAr) : "";
  const subtitle = s ? displaySubtitle(s.kind, s.subtitle, s.subtitleAr, lang) : "";
  const convLinkCount = s ? s.links.filter((l) => l.kind === "conversation").length : 0;
  let convIndex = 0;

  return (
    <div
      className="record-sheet-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        className="record-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <div
          style={{
            padding: "14px 16px 12px 20px",
            borderBottom: "1px solid var(--line)",
            background: "linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%)",
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
              {kindLabel(rec.kind, lang)}
            </div>
            <h2
              id={titleId}
              dir="auto"
              style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 700, lineHeight: 1.3, overflowWrap: "anywhere" }}
            >
              {s ? title : notFound ? tx("Not available", "غير متاح") : tx("Loading…", "جارٍ التحميل…")}
            </h2>
            {subtitle && (
              <div dir="auto" style={{ marginTop: 3, fontSize: 12, color: "var(--ink-3)", overflowWrap: "anywhere" }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn ghost icon sm"
            onClick={onClose}
            aria-label={tx("Close", "إغلاق")}
            style={{ fontSize: 20, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {s && s.links.length > 0 && (
          <nav
            aria-label={tx("Related records", "سجلات مرتبطة")}
            style={{
              padding: "10px 20px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
            }}
          >
            {s.links.map((l) => {
              let sub = displaySubtitle(l.kind, l.subtitle, l.subtitleAr, lang);
              if (l.kind === "conversation") {
                convIndex += 1;
                if (l.updatedAt) sub = `${sub} · ${formatDate(l.updatedAt, lang)}`;
                else if (convLinkCount > 1) sub = `${sub} · #${convIndex}`;
              }
              return (
              <button
                key={`${l.kind}:${l.id}`}
                type="button"
                onClick={() => openRecord(l.kind, l.id)}
                style={{
                  display: "inline-flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                  maxWidth: "100%",
                  padding: "5px 10px",
                  textAlign: "start",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-soft)",
                  borderRadius: 8,
                  color: "var(--ink)",
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                <span className="mono" style={{ fontSize: 9, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
                  {kindLabel(l.kind, lang)}
                </span>
                <span dir="auto" style={{ fontSize: 12.5, fontWeight: 500, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {pick(lang, l.title, l.titleAr)}
                </span>
                {sub && (
                  <span dir="auto" style={{ fontSize: 11, color: "var(--ink-3)", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sub}
                  </span>
                )}
              </button>
              );
            })}
          </nav>
        )}

        {s ? (
          <Body
            summary={s}
            lang={lang}
            onClose={onClose}
            onChanged={() => {
              void q.refetch();
              onChanged(rec);
            }}
            onDeleted={() => onDeleted(rec)}
          />
        ) : q.isPending ? (
          <div className="pulse" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true">
            {[60, 90, 75, 40].map((w, i) => (
              <div key={i} style={{ height: 14, width: `${w}%`, background: "var(--bg-2)", borderRadius: 6 }} />
            ))}
          </div>
        ) : (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
            <div role="alert" style={{ fontSize: 13, color: notFound ? "var(--ink-2)" : "var(--bad)" }}>
              {notFound
                ? tx("This record isn't available.", "هذا السجل غير متاح.")
                : tx("Couldn't load this record.", "تعذّر تحميل هذا السجل.")}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {!notFound && (
                <button type="button" className="btn" onClick={() => void q.refetch()}>
                  {tx("Retry", "إعادة المحاولة")}
                </button>
              )}
              <button type="button" className="btn primary" onClick={onClose}>
                {tx("Close", "إغلاق")}
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
