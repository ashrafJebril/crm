import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { Avatar } from "@/components/Avatar";
import {
  useAddNote,
  useDeleteTicket,
  useUpdateTicket,
} from "./hooks/useTicketMutations";
import { stageColor } from "./stageColors";
import type {
  Lang,
  TicketActivity,
  TicketDetail,
  TicketStage,
} from "@/lib/types";

interface Props {
  ticketId: string;
  pipelineId: string;
  stageId: string;
  lang: Lang;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}

export function TicketDetailDrawer({
  ticketId,
  lang,
  onClose,
  onOpenConversation,
}: Props) {
  const q = useQuery<TicketDetail>({
    queryKey: qk.ticket(ticketId),
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${ticketId}`, signal),
  });

  const addNote = useAddNote();
  const update = useUpdateTicket();
  const del = useDeleteTicket();

  const [noteText, setNoteText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = q.data;

  // Quick lookup of stage label + color by stage key for activity entries.
  const stageByKey = useMemo(() => {
    const map = new Map<string, TicketStage>();
    t?.pipeline?.stages?.forEach((s) => map.set(s.key, s));
    return map;
  }, [t]);

  const currentStage = t?.stage;
  const currentAccent = currentStage
    ? stageColor[currentStage.color] ?? "var(--ink-3)"
    : "var(--ink-3)";

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
        justifyContent: lang === "ar" ? "flex-start" : "flex-end",
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
          borderLeft: lang === "ar" ? 0 : "1px solid var(--line)",
          borderRight: lang === "ar" ? "1px solid var(--line)" : 0,
          boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {q.isLoading ? (
          <div
            style={{
              padding: 24,
              color: "var(--ink-3)",
              fontSize: 12,
            }}
          >
            {lang === "ar" ? "جارٍ التحميل..." : "Loading..."}
          </div>
        ) : !t ? (
          <div style={{ padding: 24, color: "var(--bad)", fontSize: 13 }}>
            {lang === "ar" ? "التذكرة غير موجودة" : "Ticket not found"}
          </div>
        ) : (
          <>
            {/* ── Header ───────────────────────────────────────────────── */}
            <div
              style={{
                padding: "16px 20px 14px",
                borderBottom: "1px solid var(--line)",
                position: "relative",
                background:
                  "linear-gradient(180deg, var(--bg-2) 0%, var(--bg-1) 100%)",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  background: currentAccent,
                  opacity: 0.85,
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    color: "var(--ink-3)",
                    letterSpacing: 0.06,
                    fontWeight: 500,
                  }}
                >
                  #{String(t.number).padStart(3, "0")}
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "var(--ink-3)",
                    cursor: "pointer",
                    fontSize: 18,
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

              <h2
                style={{
                  margin: 0,
                  fontSize: 17,
                  color: "var(--ink)",
                  fontWeight: 700,
                  lineHeight: 1.3,
                  letterSpacing: -0.2,
                }}
              >
                {t.title}
              </h2>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                }}
              >
                {currentStage ? (
                  <StagePill stage={currentStage} lang={lang} />
                ) : null}
                {t.value != null ? (
                  <div
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "var(--ink-1)",
                      padding: "3px 8px",
                      background: `color-mix(in srgb, ${currentAccent} 10%, transparent)`,
                      borderRadius: 6,
                      border: `1px solid color-mix(in srgb, ${currentAccent} 22%, transparent)`,
                    }}
                  >
                    {t.value.toLocaleString()} {t.currency ?? "SAR"}
                  </div>
                ) : null}
              </div>
            </div>

            {/* ── Scrollable body ──────────────────────────────────────── */}
            <div style={{ flex: 1, overflowY: "auto" }}>
              <Section title={lang === "ar" ? "العميل" : "Contact"}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <Avatar name={t.contact?.name ?? "?"} size="lg" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: "var(--ink)",
                      }}
                    >
                      {t.contact?.name ?? "—"}
                    </div>
                    {t.contact?.phone ? (
                      <div
                        className="mono"
                        style={{ fontSize: 11, color: "var(--ink-3)" }}
                      >
                        {t.contact.phone}
                      </div>
                    ) : null}
                  </div>
                </div>
              </Section>

              {t.conversationId ? (
                <Section>
                  <button
                    type="button"
                    onClick={() => onOpenConversation(t.conversationId!)}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "var(--bg-2)",
                      border: "1px solid var(--line)",
                      borderRadius: 8,
                      color: "var(--ink)",
                      fontSize: 12.5,
                      cursor: "pointer",
                      textAlign: "start",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      transition: "border-color 120ms",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--line)";
                    }}
                  >
                    <span>
                      💬{" "}
                      {lang === "ar"
                        ? "افتح المحادثة المرتبطة"
                        : "Open linked conversation"}
                    </span>
                    <span style={{ color: "var(--ink-3)" }}>›</span>
                  </button>
                </Section>
              ) : null}

              <Section title={lang === "ar" ? "القيمة" : "Value"}>
                <input
                  type="number"
                  min="0"
                  defaultValue={t.value ?? 0}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (v !== (t.value ?? 0)) {
                      update.mutate({ id: t.id, patch: { value: v } });
                    }
                  }}
                  style={input}
                />
              </Section>

              <Section title={lang === "ar" ? "النشاط" : "Activity"}>
                <ActivityTimeline
                  activities={t.activities ?? []}
                  stageByKey={stageByKey}
                  lang={lang}
                />
              </Section>

              <Section title={lang === "ar" ? "إضافة ملاحظة" : "Add note"}>
                <textarea
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={
                    lang === "ar"
                      ? "اكتب ملاحظة..."
                      : "Write a note..."
                  }
                  style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
                />
                <button
                  type="button"
                  disabled={!noteText.trim() || addNote.isPending}
                  onClick={async () => {
                    await addNote.mutateAsync({
                      ticketId: t.id,
                      note: noteText.trim(),
                    });
                    setNoteText("");
                  }}
                  style={{
                    marginTop: 8,
                    padding: "7px 14px",
                    background: noteText.trim()
                      ? "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 85%, black) 100%)"
                      : "var(--bg-2)",
                    border: 0,
                    borderRadius: 8,
                    color: noteText.trim() ? "white" : "var(--ink-3)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: noteText.trim() ? "pointer" : "not-allowed",
                    alignSelf: "flex-start",
                    boxShadow: noteText.trim()
                      ? "0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.18)"
                      : "none",
                  }}
                >
                  {addNote.isPending
                    ? lang === "ar"
                      ? "..."
                      : "Saving..."
                    : lang === "ar"
                      ? "حفظ الملاحظة"
                      : "Save note"}
                </button>
              </Section>
            </div>

            {/* ── Footer ───────────────────────────────────────────────── */}
            <div
              style={{
                padding: "12px 20px",
                borderTop: "1px solid var(--line)",
                background: "var(--bg-1)",
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 8,
              }}
            >
              {confirmDelete ? (
                <>
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-2)",
                      marginRight: 4,
                    }}
                  >
                    {lang === "ar" ? "هل أنت متأكد؟" : "Are you sure?"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    style={ghostBtn}
                  >
                    {lang === "ar" ? "إلغاء" : "Cancel"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      del.mutate({
                        id: t.id,
                        pipelineId: t.pipelineId,
                        stageId: t.stageId,
                      });
                      onClose();
                    }}
                    style={{
                      ...ghostBtn,
                      color: "white",
                      background: "var(--bad, #ef4444)",
                      border: 0,
                      fontWeight: 600,
                    }}
                  >
                    {lang === "ar" ? "احذف" : "Delete"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  style={{
                    ...ghostBtn,
                    color: "var(--bad, #ef4444)",
                    borderColor: "transparent",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background =
                      "color-mix(in srgb, var(--bad, #ef4444) 12%, transparent)";
                    e.currentTarget.style.borderColor =
                      "color-mix(in srgb, var(--bad, #ef4444) 40%, transparent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "transparent";
                  }}
                >
                  {lang === "ar" ? "حذف التذكرة" : "Delete ticket"}
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: "14px 20px",
        borderBottom: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {title ? (
        <div
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            letterSpacing: 0.7,
            fontWeight: 600,
          }}
        >
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function StagePill({ stage, lang }: { stage: TicketStage; lang: Lang }) {
  const accent = stageColor[stage.color] ?? "var(--ink-3)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px 3px 8px",
        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
        borderRadius: 999,
        fontSize: 11.5,
        fontWeight: 600,
        color: "var(--ink)",
        letterSpacing: 0.1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: accent,
        }}
      />
      {lang === "ar" ? stage.labelAr : stage.label}
    </span>
  );
}

function ActivityTimeline({
  activities,
  stageByKey,
  lang,
}: {
  activities: TicketActivity[];
  stageByKey: Map<string, TicketStage>;
  lang: Lang;
}) {
  if (activities.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}>
        {lang === "ar" ? "لا يوجد نشاط بعد" : "No activity yet"}
      </div>
    );
  }

  // Render newest first so users see recent moves at the top.
  const ordered = [...activities].reverse();

  return (
    <div style={{ position: "relative", paddingLeft: 18 }}>
      {/* Timeline rail */}
      <div
        style={{
          position: "absolute",
          left: 5,
          top: 8,
          bottom: 8,
          width: 1,
          background: "var(--line)",
        }}
      />
      <div
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {ordered.map((a) => (
          <ActivityRow
            key={a.id}
            activity={a}
            stageByKey={stageByKey}
            lang={lang}
          />
        ))}
      </div>
    </div>
  );
}

function ActivityRow({
  activity: a,
  stageByKey,
  lang,
}: {
  activity: TicketActivity;
  stageByKey: Map<string, TicketStage>;
  lang: Lang;
}) {
  const fromStage = a.fromStage ? stageByKey.get(a.fromStage) : undefined;
  const toStage = a.toStage ? stageByKey.get(a.toStage) : undefined;

  const meta = describeActivity(a.kind, lang);
  const dotColor = meta.color;

  return (
    <div style={{ position: "relative", display: "flex", gap: 10 }}>
      {/* Dot */}
      <div
        style={{
          position: "absolute",
          left: -18,
          top: 4,
          width: 11,
          height: 11,
          borderRadius: 999,
          background: dotColor,
          border: "2px solid var(--bg-1)",
          boxShadow: `0 0 0 1px ${dotColor}`,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12.5,
              color: "var(--ink)",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontWeight: 600 }}>{meta.label}</span>
            {fromStage && toStage ? (
              <>
                <MiniStage stage={fromStage} lang={lang} />
                <span style={{ color: "var(--ink-3)" }}>→</span>
                <MiniStage stage={toStage} lang={lang} />
              </>
            ) : toStage ? (
              <MiniStage stage={toStage} lang={lang} />
            ) : null}
          </div>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--ink-3)",
              whiteSpace: "nowrap",
            }}
          >
            {formatRelative(a.createdAt, lang)}
          </span>
        </div>
        {a.note ? (
          <div
            style={{
              marginTop: 6,
              padding: "8px 10px",
              background: "var(--bg-2)",
              borderRadius: 6,
              borderLeft: `2px solid ${dotColor}`,
              fontSize: 12,
              color: "var(--ink-1)",
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {a.note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MiniStage({ stage, lang }: { stage: TicketStage; lang: Lang }) {
  const accent = stageColor[stage.color] ?? "var(--ink-3)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11.5,
        color: "var(--ink-1)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: accent,
        }}
      />
      {lang === "ar" ? stage.labelAr : stage.label}
    </span>
  );
}

function describeActivity(
  kind: string,
  lang: Lang,
): { label: string; color: string } {
  const en: Record<string, [string, string]> = {
    created: ["created", "var(--ink-2)"],
    stage_changed: ["moved", "var(--info, #3b82f6)"],
    owner_changed: ["assigned", "var(--info, #3b82f6)"],
    value_changed: ["value updated", "var(--ink-2)"],
    note: ["note", "var(--ink-2)"],
    won: ["won", "var(--ok, #10b981)"],
    lost: ["lost", "var(--bad, #ef4444)"],
  };
  const ar: Record<string, [string, string]> = {
    created: ["تم الإنشاء", "var(--ink-2)"],
    stage_changed: ["نُقلت", "var(--info, #3b82f6)"],
    owner_changed: ["تم التعيين", "var(--info, #3b82f6)"],
    value_changed: ["تحديث القيمة", "var(--ink-2)"],
    note: ["ملاحظة", "var(--ink-2)"],
    won: ["مكسب", "var(--ok, #10b981)"],
    lost: ["خسارة", "var(--bad, #ef4444)"],
  };
  const dict = lang === "ar" ? ar : en;
  const [label, color] = dict[kind] ?? [kind, "var(--ink-3)"];
  return { label, color };
}

function formatRelative(when: Date | string, lang: Lang): string {
  const d = typeof when === "string" ? new Date(when) : when;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (lang === "ar") {
    if (sec < 30) return "الآن";
    if (min < 1) return `قبل ${sec} ث`;
    if (hr < 1) return `قبل ${min} د`;
    if (day < 1) return `قبل ${hr} س`;
    if (day < 7) return `قبل ${day} ي`;
    return d.toLocaleDateString("ar");
  }
  if (sec < 30) return "now";
  if (min < 1) return `${sec}s ago`;
  if (hr < 1) return `${min}m ago`;
  if (day < 1) return `${hr}h ago`;
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

// ─── Style tokens ───────────────────────────────────────────────────────────

const input: React.CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  outline: "none",
};

const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--ink-2)",
  fontSize: 12,
  cursor: "pointer",
  transition: "background 120ms, border-color 120ms, color 120ms",
};
