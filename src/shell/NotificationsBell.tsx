import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFetch } from "@/api/useFetch";
import { useRealtime } from "@/api/useRealtime";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconBell } from "@/icons";
import type { Conversation, Contact } from "@/lib/types";

interface InboxActivity {
  channel: string;
  conversationId?: string;
}

interface NotificationItem {
  id: string;
  channel: string;
  conversationId?: string;
  name: string;
  preview: string;
  at: number; // epoch ms
}

interface UnreadConvRich {
  id: string;
  unread: number;
  contactName?: string;
  snippet?: string;
  contactId?: string;
}

interface ToastEntry {
  id: string;
  item: NotificationItem;
  dismissing: boolean;
}

const TOAST_DURATION_MS = 6000;
const TOAST_EXIT_MS = 220;
const MAX_VISIBLE_TOASTS = 3;
const TOAST_STYLES = `
@keyframes aram-toast-in {
  from { opacity: 0; transform: translateX(110%); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes aram-toast-out {
  from { opacity: 1; transform: translateX(0); }
  to   { opacity: 0; transform: translateX(110%); }
}
.aram-toast-stack {
  position: fixed;
  bottom: 20px;
  inset-inline-end: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 2147483640;
  pointer-events: none;
}
.aram-toast {
  pointer-events: auto;
  width: 340px;
  max-width: calc(100vw - 40px);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 16px 40px oklch(0 0 0 / 0.45), 0 4px 12px oklch(0 0 0 / 0.3);
  padding: 12px 12px 12px 14px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
  color: var(--ink);
  font-family: inherit;
  animation: aram-toast-in 220ms cubic-bezier(.2,.8,.2,1) both;
  transition: background 120ms ease;
}
.aram-toast:hover { background: var(--bg-2); }
.aram-toast[data-dismissing="true"] {
  animation: aram-toast-out 220ms cubic-bezier(.4,0,.6,1) both;
  pointer-events: none;
}
.aram-toast .dot {
  width: 8px; height: 8px; border-radius: 999px; flex: 0 0 auto;
  margin-top: 6px;
}
.aram-toast .body { flex: 1; min-width: 0; }
.aram-toast .row1 {
  display: flex; align-items: baseline; gap: 8px;
}
.aram-toast .name {
  font-size: 13px; font-weight: 600; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0;
}
.aram-toast .channel {
  font-family: var(--font-mono);
  font-size: 10px; color: var(--ink-3); flex: 0 0 auto;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.aram-toast .preview {
  margin-top: 2px;
  font-size: 12px; color: var(--ink-2); line-height: 1.35;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden;
}
.aram-toast .close {
  flex: 0 0 auto;
  background: transparent; border: 0; color: var(--ink-3);
  cursor: pointer; padding: 2px 4px; line-height: 1;
  font-size: 16px; font-family: inherit;
  margin-top: -2px;
}
.aram-toast .close:hover { color: var(--ink-1); }
`;

const CHANNEL_LABEL: Record<string, { en: string; ar: string }> = {
  whatsapp:  { en: "WhatsApp",  ar: "واتساب" },
  facebook:  { en: "Facebook",  ar: "فيسبوك" },
  instagram: { en: "Instagram", ar: "إنستغرام" },
  webchat:   { en: "Web chat",  ar: "محادثة الويب" },
  tiktok:    { en: "TikTok",    ar: "تيك توك" },
};

const CHANNEL_DOT: Record<string, string> = {
  whatsapp:  "#25D366",
  instagram: "linear-gradient(135deg, #F58529, #DD2A7B 55%, #8134AF)",
  facebook:  "#1877F2",
  tiktok:    "#000000",
  webchat:   "var(--info)",
};

const MAX_ITEMS = 20;

function relTime(now: number, then: number, isAr: boolean): string {
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

export function NotificationsBell(): React.ReactElement {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  // For the relative-time labels to tick without re-subscribing.
  const [tick, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  // Ask for OS notification permission once per session.
  const askedPermRef = useRef(false);
  useEffect(() => {
    if (askedPermRef.current) return;
    askedPermRef.current = true;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  // Pull the same conversation lists the Inbox uses (React Query dedupes the
  // requests by URL — no extra network cost). The bell drives notifications
  // off unread-count changes so it works whether the source is a webhook
  // event OR a Graph poll (essential on localhost where Meta can't deliver
  // webhooks).
  const convsQ = useFetch<Conversation[]>("/conversations", { pollMs: 30000 });
  const contactsQ = useFetch<Contact[]>("/contacts");
  // All channels are DB-backed now (Zernio webhook persists FB/IG/WA inbound),
  // so the DB conversation list alone drives the bell. The old live-Zernio
  // poll returned rows without unread/contactName and never fired anything.
  const fbConvsQ = useFetch<UnreadConvRich[]>(null, { pollMs: 30000 });
  const igConvsQ = useFetch<UnreadConvRich[]>(null, { pollMs: 30000 });

  // Toast queue (slide-in from bottom-right, visible-tab only).
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const dismissToast = (id: string): void => {
    setToasts((prev) =>
      prev.map((tt) => (tt.id === id ? { ...tt, dismissing: true } : tt)),
    );
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((tt) => tt.id !== id));
    }, TOAST_EXIT_MS);
  };

  // Realtime hint: jump on activity so the diff lands quickly when the
  // backend can reach us. Falls back gracefully to the 30s polls above
  // when it can't (e.g. localhost without a webhook tunnel).
  useRealtime<InboxActivity>("inbox.activity", () => {
    convsQ.refetch();
  });

  // First sight of any conversation is silent (baseline) so we don't flood the
  // bell with the user's existing unread on first page load. Subsequent
  // unread-count INCREASES fire a notification.
  const seenRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    interface Row { unread: number; name: string; preview: string }
    const cur = new Map<string, Row>();

    const contactsById = new Map<string, Contact>();
    for (const c of contactsQ.data ?? []) contactsById.set(c.id, c);

    for (const c of convsQ.data ?? []) {
      const contact = contactsById.get(c.contactId);
      cur.set(`${c.channel}:${c.id}`, {
        unread: c.unread ?? 0,
        name: contact?.name ?? "Contact",
        preview: c.preview ?? "",
      });
    }
    for (const c of fbConvsQ.data ?? []) {
      cur.set(`facebook:${c.id}`, {
        unread: c.unread ?? 0,
        name: c.contactName ?? "Facebook user",
        preview: c.snippet ?? "",
      });
    }
    for (const c of igConvsQ.data ?? []) {
      cur.set(`instagram:${c.id}`, {
        unread: c.unread ?? 0,
        name: c.contactName ?? "Instagram user",
        preview: c.snippet ?? "",
      });
    }

    const seen = seenRef.current;
    const fresh: NotificationItem[] = [];
    for (const [key, row] of cur) {
      const prev = seen.get(key);
      if (prev === undefined) {
        // First sight — record baseline silently.
        seen.set(key, row.unread);
        continue;
      }
      if (row.unread > prev) {
        const sep = key.indexOf(":");
        const channel = key.slice(0, sep);
        const conversationId = key.slice(sep + 1);
        seq.current += 1;
        fresh.push({
          id: `${Date.now()}-${seq.current}`,
          channel,
          conversationId,
          name: row.name,
          preview: row.preview,
          at: Date.now(),
        });
      }
      seen.set(key, row.unread);
    }
    if (fresh.length === 0) return;

    setItems((prev) => [...fresh, ...prev].slice(0, MAX_ITEMS));
    setUnread((n) => n + fresh.length);

    const tabVisible = document.visibilityState === "visible";
    if (tabVisible) {
      // In-app slide-in toasts (Facebook-style, bottom-right). Cap so a
      // flood doesn't stack endlessly — keep the most recent N.
      setToasts((prev) => {
        const next = [
          ...prev,
          ...fresh.map<ToastEntry>((it) => ({ id: it.id, item: it, dismissing: false })),
        ];
        return next.slice(-MAX_VISIBLE_TOASTS);
      });
      for (const it of fresh) {
        window.setTimeout(() => dismissToast(it.id), TOAST_DURATION_MS);
      }
    } else if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      // OS-level popup when the tab isn't focused, one per channel burst.
      const byChannel = new Map<string, number>();
      for (const it of fresh) {
        byChannel.set(it.channel, (byChannel.get(it.channel) ?? 0) + 1);
      }
      for (const [ch, count] of byChannel) {
        const lbl = CHANNEL_LABEL[ch];
        const channelLabel = lbl ? (isAr ? lbl.ar : lbl.en) : ch;
        const title = isAr
          ? `${count > 1 ? `${count} ` : ""}رسالة ${channelLabel} جديدة`
          : `${count > 1 ? `${count} new ` : "New "}${channelLabel} message${count > 1 ? "s" : ""}`;
        const n = new Notification(title, {
          body: isAr ? "افتح الصندوق للقراءة" : "Open Aram to read",
          tag: `aram-inbox-${ch}`,
          icon: "/favicon.svg",
        });
        n.onclick = () => {
          window.focus();
          window.location.hash = "#/inbox";
          n.close();
        };
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convsQ.data, fbConvsQ.data, igConvsQ.data, contactsQ.data, isAr]);

  // Tick the relative-time labels once a minute so "just now" → "1m" etc.
  useEffect(() => {
    if (!open && items.length === 0) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [open, items.length]);

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) setUnread(0); // opening = mark all read
      return next;
    });
  };

  const goToInbox = () => {
    window.location.hash = "#/inbox";
    setOpen(false);
  };

  const clearAll = () => {
    setItems([]);
    setUnread(0);
  };

  const now = Date.now();
  void tick; // re-render trigger
  const sorted = useMemo(() => items, [items]);
  const badge = unread > 9 ? "9+" : String(unread);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="btn ghost icon"
        title={tx("Notifications", "الإشعارات")}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ position: "relative" }}
      >
        <IconBell w={16} />
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 2,
              insetInlineEnd: 2,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              background: "var(--accent)",
              color: "var(--bg)",
              borderRadius: 999,
              fontSize: 9,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              display: "grid",
              placeItems: "center",
              lineHeight: 1,
              boxShadow: "0 0 0 1.5px var(--bg)",
            }}
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            width: 320,
            maxHeight: 420,
            background: "var(--bg-elev)",
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 12px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: 0.06,
                flex: 1,
              }}
            >
              {tx("Notifications", "الإشعارات")}
              {sorted.length > 0 && (
                <span style={{ marginInlineStart: 8, color: "var(--ink-2)" }}>
                  · {sorted.length}
                </span>
              )}
            </span>
            {sorted.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--ink-3)",
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  padding: "2px 4px",
                }}
                title={tx("Clear all", "مسح الكل")}
              >
                {tx("Clear", "مسح")}
              </button>
            )}
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {sorted.length === 0 ? (
              <div
                style={{
                  padding: "24px 16px",
                  textAlign: "center",
                  color: "var(--ink-3)",
                  fontSize: 12,
                }}
              >
                {tx("You're all caught up.", "لا توجد إشعارات جديدة.")}
              </div>
            ) : (
              sorted.map((it) => {
                const lbl = CHANNEL_LABEL[it.channel];
                const channelLabel = lbl ? (isAr ? lbl.ar : lbl.en) : it.channel;
                const dot = CHANNEL_DOT[it.channel] ?? "var(--ink-3)";
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={goToInbox}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      padding: "10px 12px",
                      width: "100%",
                      textAlign: "start",
                      background: "transparent",
                      border: 0,
                      borderBottom: "1px solid var(--line-soft)",
                      cursor: "pointer",
                      color: "var(--ink)",
                      fontFamily: "inherit",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--bg-2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: dot,
                        flex: "0 0 auto",
                        marginTop: 5,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            flex: 1,
                            minWidth: 0,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {it.name}
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            color: "var(--ink-3)",
                            flex: "0 0 auto",
                            textTransform: "uppercase",
                            letterSpacing: 0.06,
                          }}
                        >
                          {channelLabel}
                        </span>
                      </span>
                      <span
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
                        {it.preview || tx("New message", "رسالة جديدة")}
                      </span>
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        flex: "0 0 auto",
                        marginTop: 3,
                      }}
                    >
                      {relTime(now, it.at, isAr)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {toasts.length > 0 &&
        createPortal(
          <>
            <style>{TOAST_STYLES}</style>
            <div className="aram-toast-stack" aria-live="polite">
              {toasts.map((tt) => {
                const lbl = CHANNEL_LABEL[tt.item.channel];
                const channelLabel = lbl ? (isAr ? lbl.ar : lbl.en) : tt.item.channel;
                const dot = CHANNEL_DOT[tt.item.channel] ?? "var(--ink-3)";
                return (
                  <div
                    key={tt.id}
                    role="status"
                    className="aram-toast"
                    data-dismissing={tt.dismissing ? "true" : "false"}
                    onClick={(e) => {
                      // Don't navigate if the close button caught it.
                      if ((e.target as HTMLElement).closest(".close")) return;
                      window.location.hash = "#/inbox";
                      dismissToast(tt.id);
                    }}
                  >
                    <span className="dot" style={{ background: dot }} />
                    <div className="body">
                      <div className="row1">
                        <span className="name">{tt.item.name}</span>
                        <span className="channel">{channelLabel}</span>
                      </div>
                      <div className="preview">
                        {tt.item.preview || tx("New message", "رسالة جديدة")}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="close"
                      title={tx("Dismiss", "إغلاق")}
                      onClick={(e) => {
                        e.stopPropagation();
                        dismissToast(tt.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
