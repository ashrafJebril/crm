import type { Tx } from "@/lib/tx";
import { notificationText } from "@/lib/notificationText";
import type { Notification } from "@/lib/types";

export function relTimeIso(now: number, iso: string, isAr: boolean): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 10) return isAr ? "الآن" : "just now";
  if (s < 60) return isAr ? `${s} ث` : `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return isAr ? `${m} د` : `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return isAr ? `${h} س` : `${h}h`;
  const d = Math.round(h / 24);
  return isAr ? `${d} ي` : `${d}d`;
}

interface Props {
  tx: Tx;
  isAr: boolean;
  now: number;
  items: Notification[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpen: (n: Notification) => void;
  onMarkAll: () => void;
  hasUnread: boolean;
}

export function NotificationsList({
  tx,
  isAr,
  now,
  items,
  loading,
  error,
  hasMore,
  onLoadMore,
  onOpen,
  onMarkAll,
  hasUnread,
}: Props): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {hasUnread && (
        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--line-soft)" }}>
          <button
            type="button"
            onClick={onMarkAll}
            style={{
              border: 0,
              background: "transparent",
              color: "var(--accent)",
              fontSize: 11,
              cursor: "pointer",
              fontFamily: "inherit",
              padding: 0,
            }}
          >
            {tx("Mark all read", "تعليم الكل كمقروء")}
          </button>
        </div>
      )}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {items.length === 0 && !loading && (
          <div
            style={{ padding: "24px 16px", textAlign: "center", color: "var(--ink-3)", fontSize: 12 }}
          >
            {error
              ? tx("Couldn't load notifications.", "تعذّر تحميل الإشعارات.")
              : tx("No notifications yet.", "لا توجد إشعارات بعد.")}
          </div>
        )}
        {items.map((n) => {
          const txt = notificationText(tx, n);
          const unread = !n.readAt;
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onOpen(n)}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 12px",
                width: "100%",
                textAlign: "start",
                background: unread ? "var(--bg-1)" : "transparent",
                border: 0,
                borderBottom: "1px solid var(--line-soft)",
                cursor: "pointer",
                color: "var(--ink)",
                fontFamily: "inherit",
              }}
            >
              <span
                role={unread ? "img" : undefined}
                aria-label={unread ? tx("Unread", "غير مقروء") : undefined}
                aria-hidden={unread ? undefined : true}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: unread ? "var(--accent)" : "transparent",
                  flex: "0 0 auto",
                  marginTop: 6,
                }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  dir="auto"
                  style={{ display: "block", fontSize: 13, fontWeight: unread ? 600 : 400 }}
                >
                  {txt.title}
                </span>
                {txt.body && (
                  <span
                    dir="auto"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                      fontSize: 12,
                      color: "var(--ink-2)",
                      marginTop: 2,
                      lineHeight: 1.35,
                    }}
                  >
                    {txt.body}
                  </span>
                )}
              </span>
              <span
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)", flex: "0 0 auto", marginTop: 3 }}
              >
                {relTimeIso(now, n.createdAt, isAr)}
              </span>
            </button>
          );
        })}
        {hasMore && (
          <div style={{ padding: 8, textAlign: "center" }}>
            <button type="button" className="btn ghost sm" disabled={loading} onClick={onLoadMore}>
              {loading ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
