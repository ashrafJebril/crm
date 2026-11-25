import { useMemo, useState } from "react";
import { ActivityList } from "@/components/activities/ActivityList";
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
import { useBulkTickets, useReopenTicket } from "./hooks/useBoardData";
import { bulkResultText, ticketActionError } from "./boardQuery";
import { useToast } from "@/components/Toast";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type {
  Lang,
  TicketActivity,
  TicketCategory,
  TicketDetail,
  TicketPriority,
  TicketStage,
} from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { useWorkspaceTz } from "@/components/activities/activityApi";
import { ChannelChip, PriorityChip, SlaBadgeChip } from "./TicketBadges";
import { TicketAttachments } from "./TicketAttachments";
import { TicketBookingCards } from "./TicketBookingCards";
import { ResolveDialog } from "./ResolveDialog";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, categoryLabel, isCategory, priorityLabel, ticketPriority } from "./ticketFields";
import { formatSlaDue, ticketSlaState } from "./ticketSla";
import { ticketErrorText } from "./ticketErrors";

interface Props {
  ticketId: string;
  pipelineId: string;
  stageId: string;
  lang: Lang;
  onClose: () => void;
  onOpenConversation: (conversationId: string) => void;
}
interface ContentProps {
  ticketId: string;
  lang: Lang;
  onClose: () => void;
  /** After a delete is submitted; defaults to onClose. */
  onDeleted?: () => void;
  onOpenConversation: (conversationId: string) => void;
  /** Inside the record sheet: the sheet frame supplies number, title and close. */
  embedded?: boolean;
}

/** The ticket detail body (header, contact, value, activity, notes, delete).
 *  Shared by the Pipeline drawer and the universal record sheet. */
export function TicketDetailContent({
  ticketId,
  lang,
  onClose,
  onDeleted,
  onOpenConversation,
  embedded,
}: ContentProps) {
  const q = useQuery<TicketDetail>({
    queryKey: qk.ticket(ticketId),
    queryFn: ({ signal }) => api.get<TicketDetail>(`/tickets/${ticketId}`, signal),
  });

  const addNote = useAddNote();
  const update = useUpdateTicket();
  const del = useDeleteTicket();
  const { can } = usePermissions();
  const canUpdate = can("tickets.update");
  const canDelete = can("tickets.delete");
  const noPerm = lang === "ar" ? NO_PERMISSION_AR : NO_PERMISSION_EN;
  const tx = makeTx(lang);
  const moveLocked = q.data?.pipeline?.agentCanMove === false && !can("pipelines.update");
  const lockedTip = tx("Only managers can move cards in this pipeline", "يمكن للمديرين فقط نقل البطاقات في هذا المسار");
  const { toast } = useToast();
  const reopen = useReopenTicket();
  const bulk = useBulkTickets(q.data?.pipelineId ?? "");
  const errText = (e: unknown) =>
    ticketActionError(tx, e instanceof ApiError ? e.message : e instanceof Error ? e.message : "");

  const [noteText, setNoteText] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resolving, setResolving] = useState(false);
  const tz = useWorkspaceTz();
  const t = q.data;
  const isSupport = t?.pipeline?.kind === "support";
  const canResolve = !!t && canUpdate && !t.closedAt && !t.stage?.isTerminal && isSupport;
  const saveField = (patch: { priority?: TicketPriority; category?: TicketCategory | null }) => {
    if (!t) return;
    update.mutate(
      { id: t.id, patch },
      { onError: (e) => toast(ticketErrorText(e, tx, tx("Couldn't save the change.", "تعذّر حفظ التغيير.")), "error", e) },
    );
  };

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
    <>
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
              {!embedded && (<>
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
                  <bdi>#{String(t.number).padStart(3, "0")}</bdi>
                </div>
                <button
                  onClick={onClose}
                  aria-label={lang === "ar" ? "إغلاق" : "Close"}
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
              </>)}

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                  flexWrap: "wrap",
                }}
              >
                {currentStage ? (
                  <StagePill stage={currentStage} lang={lang} />
                ) : null}
                <PriorityChip tx={tx} priority={t.priority} />
                <ChannelChip tx={tx} channel={t.channel} />
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
              {isSupport ? (
                <SupportFields t={t} tx={tx} tz={tz} canUpdate={canUpdate} saving={update.isPending} onSave={saveField} showSla />
              ) : null}
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
                  disabled={!canUpdate}
                  title={canUpdate ? undefined : noPerm}
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

              {!isSupport ? (
                <SupportFields t={t} tx={tx} tz={tz} canUpdate={canUpdate} saving={update.isPending} onSave={saveField} />
              ) : null}

              <Section title={tx("Files", "الملفات")}>
                <TicketAttachments
                  ticketId={t.id}
                  tx={tx}
                  tz={tz}
                  canUpdate={canUpdate}
                  hasConversation={!!t.conversationId}
                />
              </Section>

              {can("bookings.view") && t.contactId ? (
                <Section title={tx("Bookings", "الحجوزات")}>
                  <TicketBookingCards ticketId={t.id} tx={tx} lang={lang} tz={tz} canUpdate={can("bookings.update")} />
                </Section>
              ) : null}

              <Section title={lang === "ar" ? "المتابعات" : "Follow-ups"}>
                <ActivityList ticketId={ticketId} />
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
                  disabled={!canUpdate}
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
                  disabled={!canUpdate || !noteText.trim() || addNote.isPending}
                  title={canUpdate ? undefined : noPerm}
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
              {t.closedAt || t.pipeline?.kind === "leads" ? (
                <div style={{ display: "flex", gap: 8, marginInlineEnd: "auto" }}>
                  {t.closedAt ? (
                    <button
                      type="button"
                      disabled={!canUpdate || moveLocked || reopen.isPending}
                      title={!canUpdate ? noPerm : moveLocked ? lockedTip : undefined}
                      onClick={() =>
                        reopen.mutate(t.id, {
                          onSuccess: () => toast(tx("Card reopened", "تمت إعادة فتح البطاقة"), "success"),
                          onError: (e) => toast(errText(e), "error"),
                        })
                      }
                      style={ghostBtn}
                    >
                      {tx("Reopen", "إعادة فتح")}
                    </button>
                  ) : t.pipeline?.kind === "leads" ? (
                    <button
                      type="button"
                      disabled={!canUpdate || !can("contacts.update") || moveLocked || bulk.isPending}
                      title={!(canUpdate && can("contacts.update")) ? noPerm : moveLocked ? lockedTip : undefined}
                      onClick={() =>
                        bulk.mutate(
                          { ids: [t.id], op: "notALead" },
                          {
                            onSuccess: (r) => toast(bulkResultText(tx, r), r.affected > 0 ? "success" : "info"),
                            onError: (e) => toast(errText(e), "error"),
                          },
                        )
                      }
                      style={ghostBtn}
                    >
                      {tx("Not a lead", "ليس عميلاً محتملاً")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {canResolve ? (
                <button
                  type="button"
                  disabled={moveLocked}
                  title={moveLocked ? lockedTip : undefined}
                  onClick={() => setResolving(true)}
                  style={{
                    ...ghostBtn,
                    marginInlineEnd: "auto",
                    color: "var(--ok, #10b981)",
                    borderColor: "color-mix(in srgb, var(--ok, #10b981) 40%, var(--line))",
                    fontWeight: 600,
                  }}
                >
                  {tx("Resolve", "حل")}
                </button>
              ) : null}
              {resolving ? <ResolveDialog ticketId={t.id} lang={lang} onClose={() => setResolving(false)} /> : null}
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
                    disabled={del.isPending}
                    onClick={async () => {
                      try {
                        await del.mutateAsync({
                          id: t.id,
                          pipelineId: t.pipelineId,
                          stageId: t.stageId,
                        });
                      } catch {
                        return; // keep the panel open; the error shows below
                      }
                      (onDeleted ?? onClose)();
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
                  {del.isError && (
                    <span role="alert" style={{ fontSize: 11.5, color: "var(--bad, #ef4444)" }}>
                      {lang === "ar" ? "تعذّر حذف التذكرة" : "Couldn't delete the ticket"}
                    </span>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!canDelete}
                  title={canDelete ? undefined : noPerm}
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
    </>
  );
}

export function TicketDetailDrawer({ ticketId, lang, onClose, onOpenConversation }: Props) {
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
        <TicketDetailContent
          ticketId={ticketId}
          lang={lang}
          onClose={onClose}
          onOpenConversation={onOpenConversation}
        />
      </aside>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/** SP-09: priority and category (editable with tickets.update), the SLA line and the channel. */
function SupportFields({
  t,
  tx,
  tz,
  canUpdate,
  saving,
  onSave,
  showSla = false,
}: {
  t: TicketDetail;
  tx: Tx;
  tz: string;
  canUpdate: boolean;
  saving: boolean;
  /** Final review I1: the SLA line on support pipelines only. */
  showSla?: boolean;
  onSave: (patch: { priority?: TicketPriority; category?: TicketCategory | null }) => void;
}) {
  const priority = ticketPriority(t.priority);
  const category = isCategory(t.category) ? t.category : "";
  const sla = ticketSlaState(t, t.stage?.isTerminal);
  const label: React.CSSProperties = { fontSize: 11, color: "var(--ink-3)", minWidth: 72 };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
  return (
    <Section title={tx("Support", "الدعم")}>
      <div style={row}>
        <span style={label}>{tx("Priority", "الأولوية")}</span>
        {canUpdate ? (
          <select
            aria-label={tx("Priority", "الأولوية")}
            value={priority}
            disabled={saving}
            onChange={(e) => onSave({ priority: e.target.value as TicketPriority })}
            style={{ ...input, width: "auto", paddingBlock: 4 }}
          >
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {priorityLabel(tx, p)}
              </option>
            ))}
          </select>
        ) : (
          <PriorityChip tx={tx} priority={priority} always />
        )}
      </div>
      <div style={row}>
        <span style={label}>{tx("Category", "التصنيف")}</span>
        {canUpdate ? (
          <select
            aria-label={tx("Category", "التصنيف")}
            value={category}
            disabled={saving}
            onChange={(e) => onSave({ category: (e.target.value || null) as TicketCategory | null })}
            style={{ ...input, width: "auto", paddingBlock: 4 }}
          >
            <option value="">{tx("Not set", "غير محدد")}</option>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(tx, c)}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: 12.5, color: "var(--ink)" }}>{categoryLabel(tx, t.category) ?? "—"}</span>
        )}
      </div>
      {showSla ? (
        <div style={row}>
          <span style={label}>{tx("SLA", "المهلة")}</span>
          {sla === "finished" ? (
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Closed", "مغلقة")}</span>
          ) : (
            <>
              <SlaBadgeChip tx={tx} tz={tz} ticket={t} stageIsTerminal={t.stage?.isTerminal} showNone showOnTrack={false} />
              {t.slaDueAt ? (
                <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                  {tx("Due", "تستحق")} <bdi>{formatSlaDue(t.slaDueAt, tz, tx)}</bdi>
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {t.channel ? (
        <div style={row}>
          <span style={label}>{tx("Channel", "القناة")}</span>
          <ChannelChip tx={tx} channel={t.channel} />
        </div>
      ) : null}
    </Section>
  );
}

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
