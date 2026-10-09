import { IconBook, IconCheck, IconSearch } from "@/icons";
import { Skeleton } from "@/components/Skeleton";
import type { Tx } from "@/lib/tx";
import type { AdsLocale, AdsPromptCategory, AdsPromptEntry } from "@/api/ads";
import { IcCopy, IcLock, IcPlay } from "./icons";

export type PromptCat = "all" | AdsPromptCategory;

// All + the seven server categories, in the order the design lays them out.
const CATS: PromptCat[] = [
  "all",
  "analysis",
  "optimization",
  "audience",
  "creative",
  "create",
  "bulk_ops",
  "trends",
];

const catLabel = (c: PromptCat, tx: Tx): string => {
  switch (c) {
    case "all":
      return tx("All", "الكل");
    case "analysis":
      return tx("Analysis", "تحليل");
    case "optimization":
      return tx("Optimization", "تحسين");
    case "audience":
      return tx("Audience", "الجمهور");
    case "creative":
      return tx("Creative", "التصاميم");
    case "create":
      return tx("Create", "إنشاء");
    case "bulk_ops":
      return tx("Bulk Ops", "عمليات جماعية");
    case "trends":
      return tx("Trends", "الاتجاهات");
  }
};

interface PromptRowProps {
  entry: AdsPromptEntry;
  locale: AdsLocale;
  tx: Tx;
  disabled: boolean;
  copied: boolean;
  onCopy: (e: AdsPromptEntry) => void;
  onRun: (e: AdsPromptEntry) => void;
}

/**
 * Two-line 56px row: title (bold) + description (muted), BOTH always visible,
 * each one line with an ellipsis. Locked rows get a "Soon" badge and a lock
 * instead of the run button — so they can never fire a request (the server's
 * own refusal stays the source of truth).
 */
function PromptRow({ entry, locale, tx, disabled, copied, onCopy, onRun }: PromptRowProps) {
  const active = entry.status === "active";
  const runnable = active && !disabled;
  const title = locale === "en" ? entry.titleEn : entry.titleAr;
  const desc = locale === "en" ? entry.descEn : entry.descAr;

  return (
    <div className={`ads-row ${active ? "" : "locked"}`.trim()}>
      <div className="text">
        <div className="name">
          <span className="label" dir="auto">
            {title}
          </span>
          {!active && (
            <span className="ads-soon">
              <IcLock size={11} />
              {tx("Soon", "قريباً")}
            </span>
          )}
        </div>
        <div className="desc" dir="auto">
          {desc}
        </div>
      </div>
      <div className="acts">
        {active ? (
          <>
            <button
              type="button"
              className={`ads-icon-btn ${copied ? "copied" : ""}`.trim()}
              onClick={() => onCopy(entry)}
              aria-label={tx("Copy prompt", "نسخ البرومبت")}
            >
              {copied ? <IconCheck w={15} /> : <IcCopy />}
            </button>
            <button
              type="button"
              className="ads-run-btn"
              onClick={() => onRun(entry)}
              disabled={!runnable}
              aria-label={tx("Run", "تشغيل")}
            >
              <IcPlay />
            </button>
          </>
        ) : (
          <span className="ads-lock">
            <IcLock />
          </span>
        )}
      </div>
    </div>
  );
}

interface PromptLibraryProps {
  tx: Tx;
  locale: AdsLocale;
  cat: PromptCat;
  onCat: (c: PromptCat) => void;
  q: string;
  onQ: (v: string) => void;
  /** Active chip ∩ search — the count badge reflects THIS set, not the total. */
  filtered: AdsPromptEntry[];
  loading: boolean;
  disabled: boolean;
  copiedId: string | null;
  onCopy: (e: AdsPromptEntry) => void;
  onRun: (e: AdsPromptEntry) => void;
}

export function PromptLibrary({
  tx,
  locale,
  cat,
  onCat,
  q,
  onQ,
  filtered,
  loading,
  disabled,
  copiedId,
  onCopy,
  onRun,
}: PromptLibraryProps) {
  // Latin digits regardless of UI language — the rest of the app formats counts
  // the same way.
  const n = filtered.length.toLocaleString("en-US");
  return (
    <div className="ads-lib">
      <div className="ads-lib-head">
        <span className="name">
          <span className="glyph">
            <IconBook w={17} />
          </span>
          {tx("Prompt Library", "مكتبة البرومبتات")}
        </span>
        <span style={{ color: "var(--ink-3)", fontSize: 12, fontWeight: 500 }}>
          {tx(`${n} prompts`, `${n} برومبت`)}
        </span>
      </div>

      <div className="ads-chips">
        {CATS.map((c) => (
          <button
            key={c}
            type="button"
            className={`ads-chip ${cat === c ? "on" : ""}`.trim()}
            onClick={() => onCat(c)}
          >
            {catLabel(c, tx)}
          </button>
        ))}
      </div>

      <div className="ads-search">
        <IconSearch w={16} />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder={tx("Search prompts…", "ابحث في البرومبتات…")}
          dir="auto"
        />
      </div>

      <div className="ads-rows">
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "12px 6px" }}>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Skeleton h={11} w="52%" />
                <Skeleton h={9} w="80%" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="ads-lib-empty">
            {tx("No prompts match your search.", "ما في برومبتات مطابقة لبحثك.")}
          </div>
        ) : (
          filtered.map((p) => (
            <PromptRow
              key={p.id}
              entry={p}
              locale={locale}
              tx={tx}
              disabled={disabled}
              copied={copiedId === p.id}
              onCopy={onCopy}
              onRun={onRun}
            />
          ))
        )}
      </div>
    </div>
  );
}
