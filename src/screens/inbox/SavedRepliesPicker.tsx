import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useFetch } from "@/api/useFetch";
import { usePermissions } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { Popover } from "./Popover";
import { filterSavedReplies, pickReplyBody, slashQuery, type SavedReply } from "./thread/threadModel";

export const SAVED_REPLIES_PATH = "/saved-replies";

const CHIP_COUNT = 4;

/** Add a saved reply to the composer: replaces an empty draft or a pending
 *  "/shortcut" token, otherwise appends on a new line. */
export function insertReply(draft: string, body: string): string {
  if (!body) return draft;
  if (!draft.trim() || slashQuery(draft) !== null) return body;
  return `${draft.replace(/\s+$/, "")}\n${body}`;
}

/** Saved-replies strip (first few as chips + a full list popover) and the
 *  "/" shortcut menu. Both replace the old hardcoded quick-reply chips. */
export function useSavedReplies({
  draft,
  setDraft,
  lang,
  tx,
  disabled,
}: {
  draft: string;
  setDraft: (v: string) => void;
  lang: Lang;
  tx: Tx;
  disabled: boolean;
}): {
  /** The chips row (null while empty/loading and nothing to manage). */
  strip: ReactNode;
  /** The "/" menu, anchored above the composer. */
  slashMenu: ReactNode;
  /** Call from the textarea's onKeyDown; returns true when the key was consumed. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
} {
  const q = useFetch<SavedReply[]>(SAVED_REPLIES_PATH);
  const { can } = usePermissions();
  const replies = q.data ?? [];

  const query = slashQuery(draft);
  const matches = useMemo(() => (query === null ? [] : filterSavedReplies(replies, query)), [replies, query]);
  const [index, setIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (query === null) setDismissedFor(null);
  }, [query]);

  const open = !disabled && query !== null && dismissedFor !== draft;
  const pick = (r: SavedReply) => setDraft(insertReply(draft, pickReplyBody(r, lang)));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissedFor(draft);
      return true;
    }
    if (matches.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(matches[Math.min(index, matches.length - 1)]!);
      return true;
    }
    return false;
  };

  const strip =
    replies.length === 0 ? (
      can("conversations.manage") && !q.loading ? (
        <div style={{ marginBottom: 10, fontSize: 11.5 }} className="muted">
          {tx("No saved replies yet. ", "لا توجد ردود محفوظة بعد. ")}
          <a href="#/settings?tab=savedReplies">{tx("Add some in Settings", "أضف ردودًا من الإعدادات")}</a>
        </div>
      ) : null
    ) : (
      <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        {replies.slice(0, CHIP_COUNT).map((r) => (
          <button
            key={r.id}
            type="button"
            className="ix-quick"
            dir="auto"
            disabled={disabled}
            title={`/${r.shortcut}`}
            onClick={() => pick(r)}
          >
            {r.title}
          </button>
        ))}
        {replies.length > CHIP_COUNT && (
          <Popover
            trigger={<span>{tx("More", "المزيد")} ({replies.length - CHIP_COUNT})</span>}
            triggerClassName="ix-quick"
            role="menu"
            ariaLabel={tx("Saved replies", "الردود المحفوظة")}
            panelStyle={{ minWidth: 240, maxHeight: 280, overflowY: "auto", padding: 4, top: "auto", bottom: "calc(100% + 4px)" }}
          >
            {(close) =>
              replies.slice(CHIP_COUNT).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  className="btn ghost sm"
                  dir="auto"
                  style={{ width: "100%", justifyContent: "flex-start" }}
                  onClick={() => {
                    pick(r);
                    close();
                  }}
                >
                  {r.title} <span className="mono muted">/{r.shortcut}</span>
                </button>
              ))
            }
          </Popover>
        )}
      </div>
    );

  const slashMenu = open ? (
    <div
      role="listbox"
      aria-label={tx("Saved replies", "الردود المحفوظة")}
      style={{
        marginBottom: 8,
        maxHeight: 220,
        overflowY: "auto",
        border: "1px solid var(--line)",
        borderRadius: 10,
        background: "var(--bg-elev)",
        boxShadow: "var(--ix-shadow)",
        padding: 4,
      }}
    >
      {matches.length === 0 ? (
        <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}>
          {q.loading
            ? tx("Loading…", "جارٍ التحميل…")
            : tx("No saved reply matches", "لا يوجد رد محفوظ مطابق")}
        </div>
      ) : (
        matches.map((r, i) => (
          <button
            key={r.id}
            type="button"
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(r)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "start",
              padding: "6px 10px",
              borderRadius: 7,
              border: 0,
              cursor: "pointer",
              fontFamily: "inherit",
              color: "var(--ink)",
              background: i === index ? "var(--accent-soft)" : "transparent",
            }}
          >
            <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>/{r.shortcut}</span>{" "}
            <span style={{ fontSize: 12.5, fontWeight: 500 }} dir="auto">{r.title}</span>
            <span
              dir="auto"
              style={{
                display: "block",
                fontSize: 11.5,
                color: "var(--ink-3)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {pickReplyBody(r, lang)}
            </span>
          </button>
        ))
      )}
    </div>
  ) : null;

  return { strip, slashMenu, onKeyDown };
}
