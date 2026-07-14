import { useEffect } from "react";
import { useFetch } from "@/api/useFetch";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { NotesPanel } from "@/components/NotesPanel";
import type { Contact } from "@/lib/types";

interface RecentConv {
  id: string;
  channel: string;
  preview: string;
  lastAt: string;
  unread: number;
  status: string;
}

interface RecentTicket {
  id: string;
  number: number;
  title: string;
  value: number | null;
  currency: string;
  closedAt: string | null;
  stage: { label: string; color: string } | null;
}

interface ContactSummary {
  contact: Contact;
  stats: {
    conversations: number;
    messages: number;
    tickets: number;
    notes: number;
    appointments: number;
    channels: Record<string, number>;
  };
  recentConversations: RecentConv[];
  recentTickets: RecentTicket[];
}

interface Props {
  contactId: string;
  onClose: () => void;
}

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

const STAGE_COLOR_VAR: Record<string, string> = {
  ink:    "var(--ink-3)",
  info:   "var(--info)",
  ok:     "var(--ok)",
  warn:   "var(--warn)",
  bad:    "var(--bad)",
  accent: "var(--accent)",
  human:  "var(--info)",
};

function tagKind(tag: string): BadgeKind {
  if (tag === "VIP") return "warn";
  if (tag === "Hot") return "bad";
  return "";
}

export function ContactDetailDrawer({ contactId, onClose }: Props) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const sumQ = useFetch<ContactSummary>(`/contacts/${contactId}/summary`);
  const s = sumQ.data;
  const c = s?.contact;

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openInbox = (convId: string): void => {
    window.location.hash = `#/inbox?conversation=${encodeURIComponent(convId)}`;
    onClose();
  };
  const openPipeline = (): void => {
    window.location.hash = "#/pipeline";
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        display: "flex",
        justifyContent: isAr ? "flex-start" : "flex-end",
        background: "rgba(0,0,0,0.35)",
        backdropFilter: "blur(2px)",
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(460px, 94vw)",
          height: "100%",
          background: "var(--bg-1)",
          borderLeft: isAr ? 0 : "1px solid var(--line)",
          borderRight: isAr ? "1px solid var(--line)" : 0,
          boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {sumQ.loading && !c ? (
          <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 12 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        ) : !c ? (
          <div style={{ padding: 24, color: "var(--bad)", fontSize: 13 }}>
            {sumQ.error ?? tx("Contact not found", "جهة الاتصال غير موجودة")}
          </div>
        ) : (
          <>
            {/* ── Header ───────────────────────────────────────────────── */}
            <div
              style={{
                padding: "16px 20px 14px",
                borderBottom: "1px solid var(--line)",
                background:
                  "linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%)",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <Avatar
                name={c.name}
                color={String(150 + (c.id.charCodeAt(1) || 0) * 6)}
                size="lg"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {c.name}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}
                >
                  {c.phone || "—"}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginTop: 8,
                    fontSize: 11,
                    color: "var(--ink-2)",
                  }}
                >
                  <span>{c.lifecycle}</span>
                  <span style={{ color: "var(--ink-3)" }}>·</span>
                  <span>{c.source}</span>
                  <span style={{ color: "var(--ink-3)" }}>·</span>
                  <span className="mono" style={{ color: "var(--ink-3)" }}>
                    {tx("seen", "آخر ظهور")} {c.lastSeen}
                  </span>
                </div>
                {c.tags.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 4,
                      marginTop: 10,
                    }}
                  >
                    {c.tags.map((tg) => (
                      <Badge key={tg} kind={tagKind(tg)}>
                        {tg}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={onClose}
                aria-label={tx("Close", "إغلاق")}
                style={{
                  background: "transparent",
                  border: 0,
                  color: "var(--ink-3)",
                  cursor: "pointer",
                  fontSize: 20,
                  lineHeight: 1,
                  padding: 4,
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--ink)";
                  e.currentTarget.style.background = "var(--bg-2)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--ink-3)";
                  e.currentTarget.style.background = "transparent";
                }}
              >
                ×
              </button>
            </div>

            {/* ── Scrollable body ──────────────────────────────────────── */}
            <div style={{ overflowY: "auto", flex: 1, padding: "14px 16px 24px" }}>
              {/* Stats grid */}
              {s && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 8,
                  }}
                >
                  <Stat label={tx("Convs", "محادثات")} value={s.stats.conversations} />
                  <Stat label={tx("Msgs", "رسائل")} value={s.stats.messages} />
                  <Stat label={tx("Tickets", "تذاكر")} value={s.stats.tickets} />
                  <Stat label={tx("Notes", "ملاحظات")} value={s.stats.notes} />
                </div>
              )}

              {/* Channel breakdown */}
              {s && Object.keys(s.stats.channels).length > 0 && (
                <Section label={tx("Channels", "القنوات")}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                    }}
                  >
                    {Object.entries(s.stats.channels).map(([ch, count]) => {
                      const lbl = CHANNEL_LABEL[ch];
                      const dot = CHANNEL_DOT[ch] ?? "var(--ink-3)";
                      return (
                        <span
                          key={ch}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "3px 8px",
                            borderRadius: 999,
                            background: "var(--bg-2)",
                            border: "1px solid var(--line-soft)",
                            fontSize: 11,
                            color: "var(--ink-2)",
                          }}
                        >
                          <span
                            aria-hidden
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 999,
                              background: dot,
                            }}
                          />
                          {lbl ? (isAr ? lbl.ar : lbl.en) : ch}
                          <span
                            className="mono"
                            style={{ color: "var(--ink-3)", fontSize: 10 }}
                          >
                            {count}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </Section>
              )}

              {/* Recent conversations */}
              <Section
                label={tx("Recent conversations", "أحدث المحادثات")}
                empty={
                  s && s.recentConversations.length === 0
                    ? tx("No conversations yet.", "لا توجد محادثات بعد.")
                    : null
                }
              >
                {s?.recentConversations.map((rc) => {
                  const lbl = CHANNEL_LABEL[rc.channel];
                  const dot = CHANNEL_DOT[rc.channel] ?? "var(--ink-3)";
                  return (
                    <button
                      key={rc.id}
                      type="button"
                      onClick={() => openInbox(rc.id)}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                        padding: "10px 10px",
                        width: "100%",
                        textAlign: "start",
                        background: "var(--bg-1)",
                        border: "1px solid var(--line-soft)",
                        borderRadius: 8,
                        cursor: "pointer",
                        color: "var(--ink)",
                        fontFamily: "inherit",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-2)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "var(--bg-1)";
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: dot,
                          marginTop: 6,
                          flex: "0 0 auto",
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
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                              textTransform: "uppercase",
                              letterSpacing: 0.06,
                              flex: 1,
                            }}
                          >
                            {lbl ? (isAr ? lbl.ar : lbl.en) : rc.channel}
                          </span>
                          <span
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                            }}
                          >
                            {rc.lastAt}
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
                          {rc.preview || tx("(no preview)", "(بدون معاينة)")}
                        </span>
                      </span>
                      {rc.unread > 0 && (
                        <span
                          aria-hidden
                          style={{
                            minWidth: 18,
                            height: 18,
                            padding: "0 4px",
                            background: "var(--accent)",
                            color: "var(--bg)",
                            borderRadius: 999,
                            fontSize: 10,
                            fontWeight: 700,
                            fontFamily: "var(--font-mono)",
                            display: "grid",
                            placeItems: "center",
                            lineHeight: 1,
                          }}
                        >
                          {rc.unread > 9 ? "9+" : rc.unread}
                        </span>
                      )}
                    </button>
                  );
                })}
              </Section>

              {/* Recent tickets */}
              <Section
                label={tx("Recent tickets", "أحدث التذاكر")}
                empty={
                  s && s.recentTickets.length === 0
                    ? tx("No tickets yet.", "لا توجد تذاكر بعد.")
                    : null
                }
              >
                {s?.recentTickets.map((rt) => {
                  const accent = rt.stage
                    ? STAGE_COLOR_VAR[rt.stage.color] ?? "var(--ink-3)"
                    : "var(--ink-3)";
                  return (
                    <button
                      key={rt.id}
                      type="button"
                      onClick={openPipeline}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 10px",
                        width: "100%",
                        textAlign: "start",
                        background: "var(--bg-1)",
                        border: "1px solid var(--line-soft)",
                        borderRadius: 8,
                        cursor: "pointer",
                        color: "var(--ink)",
                        fontFamily: "inherit",
                        position: "relative",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-2)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "var(--bg-1)";
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 3,
                          height: 22,
                          background: accent,
                          borderRadius: 2,
                          flex: "0 0 auto",
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 6,
                          }}
                        >
                          <span
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                              flex: "0 0 auto",
                            }}
                          >
                            #{String(rt.number).padStart(3, "0")}
                          </span>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {rt.title}
                          </span>
                        </span>
                        <span
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginTop: 3,
                            fontSize: 11,
                            color: "var(--ink-3)",
                          }}
                        >
                          {rt.stage && (
                            <span style={{ color: accent }}>{rt.stage.label}</span>
                          )}
                          {rt.value !== null && (
                            <span className="mono">
                              {rt.currency} {rt.value.toLocaleString()}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Section>

              {/* Notes */}
              <Section label={tx("Notes", "الملاحظات")}>
                <NotesPanel contactId={c.id} scope="contact" />
              </Section>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// ─── Small bits ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--line-soft)",
        borderRadius: 8,
        padding: "8px 10px",
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: "var(--ink)",
          marginTop: 2,
          lineHeight: 1.1,
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function Section({
  label,
  empty,
  children,
}: {
  label: string;
  empty?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 18 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {empty ? (
          <div className="mono muted" style={{ fontSize: 11, opacity: 0.7 }}>
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
