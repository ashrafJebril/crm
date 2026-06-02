import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import {
  IconAlert,
  IconBolt,
  IconCheckCircle,
  IconClock,
  IconMore,
  IconPlus,
  IconUsers,
  IconX,
} from "@/icons";
import { TEAM } from "@/data/team";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useRealtime } from "@/api/useRealtime";
import type {
  Contact,
  Note,
  Pipeline,
  Ticket,
  TicketActivity,
  TicketDetail,
  TicketStage,
  TicketsDashboardSummary,
  TeamMember,
  Lang,
} from "@/lib/types";

/* ─────────────────────────────────────────────────────────────────────── */
/* Constants                                                                */
/* ─────────────────────────────────────────────────────────────────────── */

type GroupKey = "new" | "contacted" | "interested" | "waiting" | "won" | "lost";

const GROUP_ORDER: GroupKey[] = [
  "new",
  "contacted",
  "interested",
  "waiting",
  "won",
  "lost",
];

const LOST_REASONS: Array<{ id: string; en: string; ar: string }> = [
  { id: "price",         en: "Price too high",            ar: "السعر مرتفع" },
  { id: "found_cheaper", en: "Found cheaper alternative", ar: "وجد بديلاً أرخص" },
  { id: "no_response",   en: "Customer went silent",      ar: "توقف العميل" },
  { id: "wrong_fit",     en: "Wrong product fit",         ar: "غير مناسب" },
  { id: "other",         en: "Other",                     ar: "أخرى" },
];

const STAGE_BADGE: Record<TicketStage["color"], BadgeKind> = {
  ink:    "",
  info:   "info",
  ok:     "ok",
  warn:   "warn",
  bad:    "bad",
  accent: "ai",
  human:  "human",
};

const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: "8px 12px",
  color: "var(--ink)",
  fontSize: 13,
  marginTop: 6,
  outline: "none",
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  color: "var(--ink-3)",
  fontFamily: "var(--font-mono)",
  marginTop: 12,
  display: "block",
};

/* ─────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                  */
/* ─────────────────────────────────────────────────────────────────────── */

function groupLabel(g: GroupKey, tx: Tx): string {
  switch (g) {
    case "new":        return tx("New",        "جديد");
    case "contacted":  return tx("Contacted",  "تم التواصل");
    case "interested": return tx("Interested", "مهتم");
    case "waiting":    return tx("Waiting",    "بالانتظار");
    case "won":        return tx("Won",        "تم الفوز");
    case "lost":       return tx("Lost",       "خسارة");
  }
}

function fmtMoney(value: number, currency: string): string {
  // SAR-aware formatting; falls back to plain number with currency prefix.
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "SAR",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency || "SAR"} ${value.toLocaleString("en-US")}`;
  }
}

function relTime(iso: string, tx: Tx): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const m = Math.floor(diff / 60_000);
  if (m < 1)   return tx("just now", "الآن");
  if (m < 60)  return tx(`${m}m ago`, `${m} د`);
  const h = Math.floor(m / 60);
  if (h < 24)  return tx(`${h}h ago`, `${h} س`);
  const d = Math.floor(h / 24);
  if (d < 30)  return tx(`${d}d ago`, `${d} ي`);
  const mo = Math.floor(d / 30);
  return tx(`${mo}mo ago`, `${mo} ش`);
}

interface SlaInfo {
  tone: "ok" | "warn" | "bad" | null;
  pct: number;
  label: string;
}

function slaState(t: Ticket, stage: TicketStage | undefined, tx: Tx): SlaInfo {
  if (!stage || stage.slaMinutes === null) {
    return { tone: null, pct: 0, label: "" };
  }
  const elapsedMs = Date.now() - new Date(t.enteredStageAt).getTime();
  const elapsedMin = Math.max(0, Math.floor(elapsedMs / 60_000));
  const pct = elapsedMin / stage.slaMinutes;
  let tone: "ok" | "warn" | "bad" = "ok";
  if (pct > 1)        tone = "bad";
  else if (pct >= 0.5) tone = "warn";
  const remaining = stage.slaMinutes - elapsedMin;
  const label =
    remaining >= 0
      ? tx(`${remaining}m left`, `${remaining} د متبقية`)
      : tx(`${-remaining}m over`, `${-remaining} د تأخير`);
  return { tone, pct, label };
}

function stageGroup(s: TicketStage): GroupKey {
  return (GROUP_ORDER as string[]).includes(s.groupKey)
    ? (s.groupKey as GroupKey)
    : "new";
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function activityLabel(a: TicketActivity, tx: Tx): string {
  switch (a.kind) {
    case "created":        return tx("Created",        "تم الإنشاء");
    case "stage_changed":  return tx("Stage changed",  "تغير المرحلة");
    case "owner_changed":  return tx("Owner changed",  "تغير المسؤول");
    case "value_changed":  return tx("Value changed",  "تغيرت القيمة");
    case "won":            return tx("Marked as Won",  "تم الكسب");
    case "lost":           return tx("Marked as Lost", "تم الخسارة");
    case "note":           return tx("Note",           "ملاحظة");
  }
}

function activityIcon(kind: TicketActivity["kind"]): ReactNode {
  switch (kind) {
    case "created":       return <IconBolt w={12} />;
    case "stage_changed": return <IconBolt w={12} />;
    case "owner_changed": return <IconUsers w={12} />;
    case "value_changed": return <IconBolt w={12} />;
    case "won":           return <IconCheckCircle w={12} />;
    case "lost":          return <IconAlert w={12} />;
    case "note":          return <IconMore w={12} />;
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/* KPI tile                                                                 */
/* ─────────────────────────────────────────────────────────────────────── */

interface KpiProps {
  label: string;
  value: string;
  unit?: string;
  sub: string;
  icon: ReactNode;
  tone?: "" | "ok" | "warn" | "bad";
}

function Kpi({ label, value, unit, sub, icon, tone = "" }: KpiProps) {
  const toneColor =
    tone === "ok"   ? "var(--ok)"
    : tone === "warn" ? "var(--warn)"
    : tone === "bad"  ? "var(--bad)"
    : "var(--accent)";
  return (
    <div className="stat">
      <div className="label">
        <span style={{ color: toneColor, display: "inline-flex" }}>{icon}</span>
        {label}
        <span style={{ marginInlineStart: "auto" }}>
          <IconMore w={14} />
        </span>
      </div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{sub}</div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Ticket card                                                              */
/* ─────────────────────────────────────────────────────────────────────── */

interface TicketCardViewProps {
  ticket: Ticket;
  stage: TicketStage | undefined;
  owner: TeamMember | undefined;
  tx: Tx;
  lang: Lang;
  active?: boolean;
  dragging?: boolean;
  overlay?: boolean;
}

/** Pure visuals for a ticket card. Used directly inside a column AND as the
 *  DragOverlay preview that follows the cursor. */
function TicketCardView({
  ticket,
  stage,
  owner,
  tx,
  lang,
  active = false,
  dragging = false,
  overlay = false,
}: TicketCardViewProps) {
  const sla = slaState(ticket, stage, tx);
  const stageLabel = stage
    ? lang === "ar"
      ? stage.labelAr
      : stage.label
    : "";

  const slaColor =
    sla.tone === "ok"   ? "var(--ok)"
    : sla.tone === "warn" ? "var(--warn)"
    : sla.tone === "bad"  ? "var(--bad)"
    : null;

  return (
    <div
      className={`pl-card ${active ? "active" : ""} ${dragging ? "dragging" : ""} ${overlay ? "overlay" : ""}`.trim()}
      title={ticket.title}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            letterSpacing: 0.04,
          }}
        >
          #{String(ticket.number).padStart(3, "0")}
        </span>
        {stage && (
          <Badge kind={STAGE_BADGE[stage.color]}>
            {stageLabel}
          </Badge>
        )}
        <span style={{ marginInlineStart: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {slaColor && (
            <span
              title={sla.label}
              style={{
                width: 8,
                height: 8,
                borderRadius: 8,
                background: slaColor,
                boxShadow: `0 0 0 2px color-mix(in oklch, ${slaColor} 22%, transparent)`,
                display: "inline-block",
              }}
            />
          )}
          {ticket.value !== null && (
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-1)", fontWeight: 600 }}
            >
              {fmtMoney(ticket.value, ticket.currency)}
            </span>
          )}
        </span>
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          lineHeight: 1.3,
          color: "var(--ink)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {ticket.title}
      </div>

      <div
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ticket.contact?.name ?? tx("No contact", "بدون عميل")}
          </div>
          {ticket.contact?.industry && (
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--ink-3)" }}
            >
              {ticket.contact.industry}
            </div>
          )}
        </div>
        {owner ? (
          <Avatar name={owner.name} color={owner.color} size="sm" />
        ) : (
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 999,
              border: "1px dashed var(--line)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: "var(--ink-3)",
            }}
          >
            ?
          </span>
        )}
      </div>
    </div>
  );
}

interface DraggableTicketCardProps extends TicketCardViewProps {
  onOpen: (id: string) => void;
}

/** Sortable wrapper around TicketCardView. useSortable handles smooth CSS
 *  transitions when other cards rearrange around it, so cross-column moves
 *  glide instead of teleporting. Click-vs-drag is disambiguated by the
 *  PointerSensor's 5px activation distance set on the DndContext. */
function DraggableTicketCard({ onOpen, ...view }: DraggableTicketCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: view.ticket.id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? "grabbing" : "grab",
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(view.ticket.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(view.ticket.id);
        }
      }}
    >
      <TicketCardView {...view} dragging={isDragging} />
    </div>
  );
}

interface DroppableStageProps {
  stageId: string;
  cardIds: string[];
  showSubHeader: boolean;
  children: ReactNode;
}

/** A sub-stage drop target wrapping its cards in a SortableContext. When a
 *  card is dragged into the column, the others reflow smoothly to make room
 *  instead of snapping into their new positions. */
function DroppableStage({
  stageId,
  cardIds,
  showSubHeader,
  children,
}: DroppableStageProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stageId });
  return (
    <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        style={{
          borderRadius: 8,
          border: isOver
            ? "1px dashed var(--accent)"
            : "1px dashed transparent",
          background: isOver ? "var(--accent-soft)" : "transparent",
          padding: showSubHeader ? 6 : 4,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          minHeight: showSubHeader ? 60 : 40,
          transition: "background 0.1s ease, border-color 0.1s ease",
        }}
      >
        {children}
      </div>
    </SortableContext>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Lost-reason modal                                                        */
/* ─────────────────────────────────────────────────────────────────────── */

interface LostModalProps {
  tx: Tx;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (reason: string, note: string | undefined) => void;
}

function LostModal({ tx, saving, onCancel, onConfirm }: LostModalProps) {
  const [reason, setReason] = useState<string>(LOST_REASONS[0]!.id);
  const [note, setNote] = useState<string>("");
  const isOther = reason === "other";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 110,
        backdropFilter: "blur(2px)",
      }}
      onClick={onCancel}
    >
      <div
        className="card"
        style={{ width: 420, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("Mark as Lost", "تحديد كخسارة")}
        </h3>
        <p style={{ margin: "4px 0 14px", color: "var(--ink-2)", fontSize: 13 }}>
          {tx(
            "Pick a reason so we can learn from it.",
            "اختر السبب لنتعلم منه.",
          )}
        </p>
        <label style={{ ...labelStyle, marginTop: 0 }}>
          {tx("Reason", "السبب")}
        </label>
        <select
          style={{ ...inputStyle, appearance: "none" }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          {LOST_REASONS.map((r) => (
            <option key={r.id} value={r.id}>
              {tx(r.en, r.ar)}
            </option>
          ))}
        </select>

        {isOther && (
          <>
            <label style={labelStyle}>{tx("Details", "التفاصيل")}</label>
            <textarea
              style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tx("Tell us more…", "أخبرنا بالمزيد…")}
            />
          </>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <button className="btn ghost" onClick={onCancel} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button
            className="btn primary"
            disabled={saving || (isOther && note.trim().length === 0)}
            onClick={() => onConfirm(reason, isOther ? note.trim() : undefined)}
          >
            <IconX w={13} />
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Confirm Lost", "تأكيد الخسارة")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* New ticket modal                                                         */
/* ─────────────────────────────────────────────────────────────────────── */

interface NewTicketInput {
  pipelineId: string;
  stageId: string;
  contactId: string;
  title: string;
  description?: string;
  value?: number;
  ownerId?: string;
}

interface NewTicketModalProps {
  pipeline: Pipeline;
  contacts: Contact[];
  saving: boolean;
  error: string | null;
  tx: Tx;
  lang: Lang;
  onClose: () => void;
  onCreate: (input: NewTicketInput) => Promise<void>;
}

function NewTicketModal({
  pipeline,
  contacts,
  saving,
  error,
  tx,
  lang,
  onClose,
  onCreate,
}: NewTicketModalProps) {
  const stages = useMemo(
    () => [...pipeline.stages].sort((a, b) => a.order - b.order),
    [pipeline.stages],
  );
  const [contactId, setContactId] = useState<string>(contacts[0]?.id ?? "");
  const [title, setTitle] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [valueRaw, setValueRaw] = useState<string>("");
  const [ownerId, setOwnerId] = useState<string>("");
  const [stageId, setStageId] = useState<string>(stages[0]?.id ?? "");

  const canSubmit =
    contactId.length > 0 &&
    title.trim().length > 0 &&
    stageId.length > 0 &&
    !saving;

  const submit = (): void => {
    if (!canSubmit) return;
    const valueNum = valueRaw.trim() === "" ? undefined : Number(valueRaw);
    const input: NewTicketInput = {
      pipelineId: pipeline.id,
      stageId,
      contactId,
      title: title.trim(),
    };
    if (description.trim().length > 0) input.description = description.trim();
    if (valueNum !== undefined && Number.isFinite(valueNum)) input.value = valueNum;
    if (ownerId) input.ownerId = ownerId;
    onCreate(input)
      .then(() => onClose())
      .catch(() => {
        /* error surfaced via prop */
      });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "oklch(0 0 0 / 0.5)",
        display: "grid",
        placeItems: "center",
        zIndex: 110,
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, fontSize: 16 }}>
          {tx("New ticket", "تذكرة جديدة")}
        </h3>
        <p style={{ margin: "4px 0 14px", color: "var(--ink-2)", fontSize: 13 }}>
          {tx(
            "Create a deal in the pipeline.",
            "أنشئ صفقة في خط الأنابيب.",
          )}
        </p>

        <label style={{ ...labelStyle, marginTop: 0 }}>
          {tx("Contact", "العميل")}
        </label>
        <select
          style={{ ...inputStyle, appearance: "none" }}
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
        >
          {contacts.length === 0 && (
            <option value="">{tx("No contacts", "لا توجد جهات")}</option>
          )}
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.phone}
            </option>
          ))}
        </select>

        <label style={labelStyle}>{tx("Title", "العنوان")}</label>
        <input
          style={inputStyle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={tx("e.g. Annual maintenance plan", "مثال: خطة صيانة سنوية")}
        />

        <label style={labelStyle}>{tx("Description", "الوصف")}</label>
        <textarea
          style={{ ...inputStyle, minHeight: 70, resize: "vertical" }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tx("Optional context", "سياق اختياري")}
        />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle}>{tx("Value (SAR)", "القيمة (ر.س)")}</label>
            <input
              type="number"
              min={0}
              style={inputStyle}
              value={valueRaw}
              onChange={(e) => setValueRaw(e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <label style={labelStyle}>{tx("Owner", "المسؤول")}</label>
            <select
              style={{ ...inputStyle, appearance: "none" }}
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
            >
              <option value="">{tx("Unassigned", "غير معين")}</option>
              {TEAM.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label style={labelStyle}>{tx("Stage", "المرحلة")}</label>
        <select
          style={{ ...inputStyle, appearance: "none" }}
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {lang === "ar" ? s.labelAr : s.label}
            </option>
          ))}
        </select>

        {error && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: "var(--bad)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button className="btn primary" onClick={submit} disabled={!canSubmit}>
            <IconPlus w={14} />
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Create", "إنشاء")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Slide-over detail panel                                                  */
/* ─────────────────────────────────────────────────────────────────────── */

interface DetailPanelProps {
  detail: TicketDetail;
  notes: Note[];
  owner: TeamMember | undefined;
  pipeline: Pipeline | undefined;
  tx: Tx;
  lang: Lang;
  onClose: () => void;
  onMarkWon: () => void;
  onMarkLost: () => void;
  onDelete: () => void;
  onAddNote: (note: string) => Promise<void>;
  noteSaving: boolean;
  busy: boolean;
}

function DetailPanel({
  detail,
  notes,
  owner,
  pipeline,
  tx,
  lang,
  onClose,
  onMarkWon,
  onMarkLost,
  onDelete,
  onAddNote,
  noteSaving,
  busy,
}: DetailPanelProps) {
  const [noteDraft, setNoteDraft] = useState<string>("");
  const stage = pipeline?.stages.find((s) => s.id === detail.stageId);
  const stageLabel = stage
    ? lang === "ar"
      ? stage.labelAr
      : stage.label
    : "—";
  const isWon = !!stage?.isWon;
  const isLost = !!(stage?.isTerminal && !stage.isWon);
  const days = daysSince(detail.enteredStageAt);

  const submitNote = (): void => {
    const text = noteDraft.trim();
    if (text.length === 0) return;
    onAddNote(text)
      .then(() => setNoteDraft(""))
      .catch(() => {
        /* error remains in state on parent; nothing to do here */
      });
  };

  const stageById = useMemo(() => {
    const m = new Map<string, TicketStage>();
    if (pipeline) for (const s of pipeline.stages) m.set(s.id, s);
    return m;
  }, [pipeline]);

  type TimelineItem =
    | { kind: "activity"; at: string; activity: TicketActivity }
    | { kind: "note"; at: string; note: Note };

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    for (const a of detail.activities) {
      // Hide the legacy "note" kind from TicketActivity to avoid duplicates
      // — notes now live in the Note table and are rendered from `notes`.
      if (a.kind === "note") continue;
      items.push({ kind: "activity", at: a.createdAt, activity: a });
    }
    for (const n of notes) {
      items.push({ kind: "note", at: n.createdAt, note: n });
    }
    items.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    return items;
  }, [detail.activities, notes]);

  // Legacy notes that were written to TicketActivity before the unification.
  // Show them inline alongside the new Note model entries so no history is lost.
  const legacyTicketNotes = useMemo<TimelineItem[]>(
    () =>
      detail.activities
        .filter((a) => a.kind === "note")
        .map<TimelineItem>((a) => ({ kind: "activity", at: a.createdAt, activity: a })),
    [detail.activities],
  );

  const sortedTimeline = useMemo(
    () =>
      [...timeline, ...legacyTicketNotes].sort(
        (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
      ),
    [timeline, legacyTicketNotes],
  );

  return (
    <aside
      style={{
        position: "fixed",
        top: 56,
        bottom: 0,
        insetInlineEnd: 0,
        width: 380,
        background: "var(--bg-1)",
        borderInlineStart: "1px solid var(--line-soft)",
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        zIndex: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <div
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.08,
            color: "var(--ink-3)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          #{String(detail.number).padStart(3, "0")} · {detail.title}
        </div>
        <button
          className="btn ghost icon sm"
          onClick={onClose}
          aria-label={tx("Close", "إغلاق")}
        >
          <IconX w={14} />
        </button>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.25,
            }}
          >
            {detail.title}
          </h2>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {stage && (
              <Badge kind={STAGE_BADGE[stage.color]} dot>
                {stageLabel}
              </Badge>
            )}
            {isWon && (
              <Badge kind="ok">
                <IconCheckCircle w={10} />
                {tx("Won", "ربح")}
              </Badge>
            )}
            {isLost && (
              <Badge kind="bad">
                <IconX w={10} />
                {tx("Lost", "خسارة")}
              </Badge>
            )}
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {days}{" "}
              {tx("day(s) in stage", "يوم في المرحلة")}
            </span>
          </div>
        </div>

        {detail.contact && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--line-soft)",
            }}
          >
            <Avatar name={detail.contact.name} color="200" size="lg" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{detail.contact.name}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                {detail.contact.phone}
              </div>
            </div>
            {detail.contact.industry && (
              <Badge kind="info">{detail.contact.industry}</Badge>
            )}
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--line-soft)",
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.08,
              }}
            >
              {tx("Value", "القيمة")}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>
              {detail.value !== null
                ? fmtMoney(detail.value, detail.currency)
                : "—"}
            </div>
          </div>
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              border: "1px solid var(--line-soft)",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              style={{
                fontSize: 10,
                color: "var(--ink-3)",
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: 0.08,
              }}
            >
              {tx("Owner", "المسؤول")}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              {owner ? (
                <>
                  <Avatar name={owner.name} color={owner.color} size="sm" />
                  <span style={{ fontSize: 13 }}>{owner.name}</span>
                </>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  {tx("Unassigned", "غير معين")}
                </span>
              )}
            </div>
          </div>
        </div>

        {detail.description && (
          <div>
            <SectionLabel>{tx("Description", "الوصف")}</SectionLabel>
            <div
              style={{
                marginTop: 8,
                padding: 10,
                borderRadius: 10,
                background: "var(--bg-2)",
                border: "1px solid var(--line-soft)",
                fontSize: 13,
                color: "var(--ink-1)",
                whiteSpace: "pre-wrap",
              }}
            >
              {detail.description}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>{tx("Actions", "إجراءات")}</SectionLabel>
          <div
            style={{
              marginTop: 8,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <button
              className="btn"
              onClick={onMarkWon}
              disabled={busy || isWon}
            >
              <IconCheckCircle w={13} />
              {tx("Mark Won", "ربح")}
            </button>
            <button
              className="btn"
              onClick={onMarkLost}
              disabled={busy || isLost}
            >
              <IconX w={13} />
              {tx("Mark Lost", "خسارة")}
            </button>
            <button
              className="btn ghost"
              onClick={onDelete}
              disabled={busy}
              style={{ color: "var(--bad)" }}
            >
              <IconX w={13} />
              {tx("Delete", "حذف")}
            </button>
          </div>
        </div>

        <div>
          <SectionLabel>{tx("Activity", "النشاط")}</SectionLabel>
          <div
            style={{
              marginTop: 8,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitNote();
                }
              }}
              placeholder={tx("Add a note…", "أضف ملاحظة…")}
              rows={2}
              style={{
                flex: 1,
                background: "var(--bg-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r)",
                padding: "8px 10px",
                color: "var(--ink)",
                fontSize: 13,
                outline: "none",
                resize: "vertical",
                minHeight: 38,
                maxHeight: 120,
                fontFamily: "inherit",
                lineHeight: 1.4,
              }}
            />
            <button
              className="btn primary"
              onClick={submitNote}
              disabled={noteSaving || noteDraft.trim().length === 0}
            >
              {noteSaving ? tx("…", "…") : tx("Add", "إضافة")}
            </button>
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: "12px 0 0",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {sortedTimeline.length === 0 && (
              <li className="muted" style={{ fontSize: 12 }}>
                {tx("No activity yet", "لا يوجد نشاط بعد")}
              </li>
            )}
            {sortedTimeline.map((item) => {
              if (item.kind === "note") {
                const n = item.note;
                const origin =
                  n.ticketId === detail.id
                    ? tx("ticket note", "ملاحظة على الصفقة")
                    : n.conversationId
                      ? tx("from chat", "من المحادثة")
                      : n.ticketId
                        ? tx("from another deal", "من صفقة أخرى")
                        : tx("contact note", "ملاحظة على العميل");
                return (
                  <li
                    key={`note-${n.id}`}
                    style={{
                      display: "flex",
                      gap: 8,
                      fontSize: 12,
                      alignItems: "flex-start",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--line-soft)",
                      background: "var(--bg-2)",
                    }}
                  >
                    <span style={{ color: "var(--accent)", marginTop: 1 }}>
                      {activityIcon("note")}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: "var(--ink-1)", fontWeight: 500 }}>
                        {tx("Note", "ملاحظة")}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          {" "}· {origin}
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: 3,
                          color: "var(--ink-2)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {n.body}
                      </div>
                      <div
                        className="mono"
                        style={{ marginTop: 3, fontSize: 10, color: "var(--ink-3)" }}
                      >
                        {n.authorUserId
                          ? TEAM.find((m) => m.id === n.authorUserId)?.name ??
                            n.authorUserId
                          : tx("System", "النظام")}{" "}
                        · {relTime(n.createdAt, tx)}
                      </div>
                    </div>
                  </li>
                );
              }
              const a = item.activity;
              const fromS = a.fromStage ? stageById.get(a.fromStage) : null;
              const toS = a.toStage ? stageById.get(a.toStage) : null;
              const author = a.byUserId
                ? TEAM.find((m) => m.id === a.byUserId)?.name ?? a.byUserId
                : tx("System", "النظام");
              return (
                <li
                  key={a.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    fontSize: 12,
                    alignItems: "flex-start",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--line-soft)",
                  }}
                >
                  <span style={{ color: "var(--accent)", marginTop: 1 }}>
                    {activityIcon(a.kind)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: "var(--ink-1)", fontWeight: 500 }}>
                      {activityLabel(a, tx)}
                      {a.kind === "stage_changed" && fromS && toS && (
                        <span className="muted" style={{ fontWeight: 400 }}>
                          {" "}
                          · {lang === "ar" ? fromS.labelAr : fromS.label}
                          {" → "}
                          {lang === "ar" ? toS.labelAr : toS.label}
                        </span>
                      )}
                    </div>
                    {a.note && (
                      <div
                        style={{
                          marginTop: 3,
                          color: "var(--ink-2)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {a.note}
                      </div>
                    )}
                    <div
                      className="mono"
                      style={{
                        marginTop: 3,
                        fontSize: 10,
                        color: "var(--ink-3)",
                      }}
                    >
                      {author} · {relTime(a.createdAt, tx)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

    </aside>
  );
}

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      textTransform: "uppercase",
      letterSpacing: 0.08,
      color: "var(--ink-3)",
    }}
  >
    {children}
  </div>
);

/* ─────────────────────────────────────────────────────────────────────── */
/* Main screen                                                              */
/* ─────────────────────────────────────────────────────────────────────── */

interface PendingMove {
  ticketId: string;
  stageId: string;
}

function PipelineImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [activeStageFilter, setActiveStageFilter] = useState<
    Record<GroupKey, string | null>
  >({
    new: null,
    contacted: null,
    interested: null,
    waiting: null,
    won: null,
    lost: null,
  });
  const [showNew, setShowNew] = useState<boolean>(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [pendingLost, setPendingLost] = useState<PendingMove | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // dnd-kit sensors: pointer with a 5px activation distance (lets clicks
  // through without triggering a drag) + keyboard with sortable-aware
  // coordinate getter for accessible reordering.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* ─── Data ──────────────────────────────────────────────────────────── */

  const pipelinesQ = useFetch<Pipeline[]>("/pipelines");
  const pipelines: Pipeline[] = useMemo(
    () => pipelinesQ.data ?? [],
    [pipelinesQ.data],
  );

  const activePipeline = useMemo<Pipeline | null>(() => {
    if (pipelines.length === 0) return null;
    if (pipelineId) {
      return pipelines.find((p) => p.id === pipelineId) ?? pipelines[0]!;
    }
    return pipelines.find((p) => p.isDefault) ?? pipelines[0]!;
  }, [pipelines, pipelineId]);

  const ticketsPath = activePipeline
    ? `/tickets?pipelineId=${encodeURIComponent(activePipeline.id)}`
    : null;
  const ticketsQ = useFetch<Ticket[]>(ticketsPath);
  const tickets: Ticket[] = useMemo(
    () => ticketsQ.data ?? [],
    [ticketsQ.data],
  );

  const summaryQ = useFetch<TicketsDashboardSummary>(
    "/tickets/dashboard/summary",
  );
  const summary = summaryQ.data;

  const contactsQ = useFetch<Contact[]>("/contacts");
  const contacts: Contact[] = useMemo(
    () => contactsQ.data ?? [],
    [contactsQ.data],
  );

  const detailQ = useFetch<TicketDetail>(
    selectedId ? `/tickets/${selectedId}` : null,
  );

  const _notesContactId = detailQ.data?.contactId ?? null;
  const notesQ = useFetch<Note[]>(
    _notesContactId ? `/notes?contactId=${encodeURIComponent(_notesContactId)}` : null,
  );

  /* ─── Mutations ─────────────────────────────────────────────────────── */

  // Stable cache keys — useFetch's queryKey is just [path], so we target the
  // same key for both reads and optimistic writes. No more refetch-tick hack.
  const ticketsKey = ticketsPath ? [ticketsPath] : null;
  const summaryKey = ["/tickets/dashboard/summary"];

  interface MoveInput {
    id: string;
    stageId: string;
    lostReason?: string;
    note?: string;
  }

  // Textbook React Query optimistic mutation: cancel in-flight, snapshot,
  // patch cache, run the network call, roll back on error, invalidate KPIs on
  // success. Same-key invalidation triggers a background refetch with the
  // existing data staying on screen — no flash.
  const moveTicket = useMutation<
    Ticket,
    Error,
    MoveInput,
    { prev: Ticket[] | undefined }
  >({
    mutationFn: (input) => {
      const body: Record<string, unknown> = { stageId: input.stageId };
      if (input.lostReason) body.lostReason = input.lostReason;
      if (input.note) body.note = input.note;
      return api.post<Ticket>(`/tickets/${input.id}/move`, body);
    },
    onMutate: async (input) => {
      setMoveError(null);
      if (!ticketsKey) return { prev: undefined };
      // Stop any in-flight tickets refetch — it would clobber our patch.
      await queryClient.cancelQueries({ queryKey: ticketsKey });
      const prev = queryClient.getQueryData<Ticket[]>(ticketsKey);
      queryClient.setQueryData<Ticket[]>(ticketsKey, (curr) =>
        curr
          ? curr.map((t) =>
              t.id === input.id
                ? { ...t, stageId: input.stageId, enteredStageAt: new Date().toISOString() }
                : t,
            )
          : curr,
      );
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx && ticketsKey && ctx.prev !== undefined) {
        queryClient.setQueryData(ticketsKey, ctx.prev);
      }
      setMoveError(err.message || "Move failed");
    },
    onSuccess: (updated) => {
      if (!ticketsKey) return;
      // Replace the optimistic stub with the server's authoritative ticket
      // (correct updatedAt, activities won't be in this payload but the
      // detail panel pulls its own data).
      queryClient.setQueryData<Ticket[]>(ticketsKey, (curr) =>
        curr ? curr.map((t) => (t.id === updated.id ? updated : t)) : curr,
      );
    },
    onSettled: () => {
      // KPIs (win rate, open value) may have shifted. Same-key invalidate so
      // the dashboard refetches in place without flashing.
      void queryClient.invalidateQueries({ queryKey: summaryKey });
    },
  });

  const createTicket = useMutation<Ticket, Error, NewTicketInput>({
    mutationFn: (input) => api.post<Ticket>("/tickets", input),
    onSuccess: (created) => {
      if (ticketsKey) {
        queryClient.setQueryData<Ticket[]>(ticketsKey, (curr) =>
          curr ? [created, ...curr] : [created],
        );
      }
      void queryClient.invalidateQueries({ queryKey: summaryKey });
    },
  });

  const deleteTicket = useMutation<void, Error, string>({
    mutationFn: (id) => api.delete<void>(`/tickets/${id}`),
    onSuccess: (_void, id) => {
      if (ticketsKey) {
        queryClient.setQueryData<Ticket[]>(ticketsKey, (curr) =>
          curr ? curr.filter((t) => t.id !== id) : curr,
        );
      }
      void queryClient.invalidateQueries({ queryKey: summaryKey });
    },
  });

  const addNote = useMutation<
    Note,
    Error,
    { ticketId: string; contactId: string; body: string }
  >({
    mutationFn: (input) =>
      api.post<Note>("/notes", {
        ticketId: input.ticketId,
        contactId: input.contactId,
        body: input.body,
      }),
    onSuccess: (_note, input) => {
      // The notes query path is contact-scoped; invalidate it so the
      // timeline picks up the new note. Detail panel also re-renders.
      void queryClient.invalidateQueries({
        queryKey: [`/notes?contactId=${encodeURIComponent(input.contactId)}`],
      });
      void queryClient.invalidateQueries({
        queryKey: [`/tickets/${input.ticketId}`],
      });
    },
  });

  /* ─── Derived data ──────────────────────────────────────────────────── */

  const stageById = useMemo(() => {
    const m = new Map<string, TicketStage>();
    if (activePipeline) for (const s of activePipeline.stages) m.set(s.id, s);
    return m;
  }, [activePipeline]);

  const stagesByGroup = useMemo(() => {
    const m: Record<GroupKey, TicketStage[]> = {
      new: [], contacted: [], interested: [], waiting: [], won: [], lost: [],
    };
    if (!activePipeline) return m;
    for (const s of activePipeline.stages) {
      const g = stageGroup(s);
      m[g].push(s);
    }
    for (const g of GROUP_ORDER) {
      m[g].sort((a, b) => a.order - b.order);
    }
    return m;
  }, [activePipeline]);

  const filteredTickets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter((t2) => {
      if (ownerFilter && t2.ownerId !== ownerFilter) return false;
      if (q.length > 0) {
        const inTitle = t2.title.toLowerCase().includes(q);
        const inContact = (t2.contact?.name ?? "").toLowerCase().includes(q);
        if (!inTitle && !inContact) return false;
      }
      return true;
    });
  }, [tickets, ownerFilter, search]);

  const ticketsByGroup = useMemo(() => {
    const m: Record<GroupKey, Ticket[]> = {
      new: [], contacted: [], interested: [], waiting: [], won: [], lost: [],
    };
    for (const t2 of filteredTickets) {
      const stage = stageById.get(t2.stageId);
      if (!stage) continue;
      const g = stageGroup(stage);
      m[g].push(t2);
    }
    for (const g of GROUP_ORDER) {
      m[g].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    return m;
  }, [filteredTickets, stageById]);

  /* ─── Handlers ──────────────────────────────────────────────────────── */

  // Realtime sync: when *another* client in this workspace moves a ticket,
  // patch our local cache so the card slides to the new column. For the
  // mover's own socket this is a no-op because onMutate already wrote the
  // same shape — the id-equality check short-circuits redundant work.
  useRealtime<{ ticket: Ticket; fromStageId: string; toStageId: string }>(
    "ticket.moved",
    useCallback(
      (data) => {
        if (!ticketsKey) return;
        queryClient.setQueryData<Ticket[]>(ticketsKey, (curr) => {
          if (!curr) return curr;
          const existing = curr.find((t) => t.id === data.ticket.id);
          if (existing && existing.stageId === data.ticket.stageId) {
            // Already in the right stage — nothing to do.
            return curr;
          }
          return curr.map((t) =>
            t.id === data.ticket.id ? data.ticket : t,
          );
        });
      },
      [queryClient, ticketsKey],
    ),
  );

  const handleDragStart = useCallback((event: DragStartEvent): void => {
    setActiveDragId(String(event.active.id));
    setMoveError(null);
  }, []);

  const handleDragCancel = useCallback((): void => {
    setActiveDragId(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      setActiveDragId(null);
      if (!event.over) return;
      const ticketId = String(event.active.id);
      const overId = String(event.over.id);
      // over.id may be a ticket id (when dropped onto a card) or a stage id
      // (when dropped onto empty column space). Resolve both to a stageId.
      const overTicket = tickets.find((tk) => tk.id === overId);
      const stageId = overTicket ? overTicket.stageId : overId;
      const ticket = tickets.find((tk) => tk.id === ticketId);
      if (!ticket || ticket.stageId === stageId) return;
      const target = stageById.get(stageId);
      if (!target) return;
      if (target.isTerminal && !target.isWon) {
        setPendingLost({ ticketId, stageId });
        return;
      }
      moveTicket.mutate({ id: ticketId, stageId });
    },
    [tickets, stageById, moveTicket],
  );

  const confirmLost = useCallback(
    (reason: string, note: string | undefined): void => {
      if (!pendingLost) return;
      const { ticketId, stageId } = pendingLost;
      // Close the modal immediately — onMutate already moved the card.
      setPendingLost(null);
      moveTicket.mutate({
        id: ticketId,
        stageId,
        lostReason: reason,
        ...(note ? { note } : {}),
      });
    },
    [pendingLost, moveTicket],
  );

  const handleCreate = useCallback(
    async (input: NewTicketInput): Promise<void> => {
      await createTicket.mutateAsync(input);
    },
    [createTicket],
  );

  const handleAddNote = useCallback(
    async (note: string): Promise<void> => {
      if (!selectedId) return;
      const contactId = detailQ.data?.contactId;
      if (!contactId) return;
      await addNote.mutateAsync({ ticketId: selectedId, contactId, body: note });
    },
    [addNote, selectedId, detailQ.data?.contactId],
  );

  const handleMarkWon = useCallback((): void => {
    if (!selectedId || !activePipeline) return;
    const won = activePipeline.stages.find((s) => s.isWon && s.isTerminal);
    if (!won) return;
    moveTicket.mutate({ id: selectedId, stageId: won.id });
  }, [selectedId, activePipeline, moveTicket]);

  const handleMarkLost = useCallback((): void => {
    if (!selectedId || !activePipeline) return;
    const lost = activePipeline.stages.find((s) => !s.isWon && s.isTerminal);
    if (!lost) return;
    setPendingLost({ ticketId: selectedId, stageId: lost.id });
  }, [selectedId, activePipeline]);

  const handleDelete = useCallback((): void => {
    if (!selectedId) return;
    deleteTicket.mutate(selectedId, {
      onSuccess: () => setSelectedId(null),
      onError: (e) => setMoveError(e.message || "Delete failed"),
    });
  }, [deleteTicket, selectedId]);

  const resetFilters = useCallback((): void => {
    setOwnerFilter("");
    setSearch("");
    setActiveStageFilter({
      new: null, contacted: null, interested: null,
      waiting: null, won: null, lost: null,
    });
  }, []);

  /* ─── Render ────────────────────────────────────────────────────────── */

  const currency = summary?.currency || "SAR";
  const detail = detailQ.data;
  const detailOwner =
    detail && detail.ownerId
      ? TEAM.find((m) => m.id === detail.ownerId)
      : undefined;

  const busy =
    moveTicket.isPending || deleteTicket.isPending || createTicket.isPending;

  return (
    <div style={{ overflowY: "auto", flex: 1, position: "relative" }}>
      <PageHeader
        title={tx("Pipeline", "خط الأنابيب")}
        subtitle={tx("Tickets across stages", "التذاكر عبر المراحل")}
        actions={
          <>
            <select
              className="mono"
              value={activePipeline?.id ?? ""}
              onChange={(e) => setPipelineId(e.target.value)}
              style={{
                background: "var(--bg-1)",
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                padding: "6px 12px",
                color: "var(--ink-1)",
                fontSize: 12,
                outline: "none",
                minWidth: 160,
              }}
            >
              {pipelines.length === 0 && (
                <option value="">{tx("Loading…", "جارٍ التحميل…")}</option>
              )}
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {(t.lang === "ar" ? p.nameAr : p.name) +
                    (p._count ? ` · ${p._count.tickets}` : "")}
                </option>
              ))}
            </select>
            <button
              className="btn primary"
              onClick={() => setShowNew(true)}
              disabled={!activePipeline}
            >
              <IconPlus w={14} />
              {tx("New ticket", "تذكرة جديدة")}
            </button>
          </>
        }
      />

      <div style={{ padding: "0 24px 24px", display: "grid", gap: 16 }}>
        {/* Loading / error banner */}
        {(pipelinesQ.loading && pipelines.length === 0) && (
          <div
            className="mono"
            style={{
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--ink-3)",
              opacity: 0.7,
            }}
          >
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {(pipelinesQ.error || ticketsQ.error || moveError) && (
          <div
            style={{
              padding: "8px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--bad)",
              border: "1px solid var(--bad)",
              borderRadius: 8,
              background: "oklch(0.7 0.22 24 / 0.08)",
            }}
          >
            <span style={{ flex: 1 }}>
              {pipelinesQ.error || ticketsQ.error || moveError}
            </span>
            <button
              className="btn sm ghost"
              onClick={() => {
                setMoveError(null);
                pipelinesQ.refetch();
                ticketsQ.refetch();
              }}
            >
              {tx("Retry", "إعادة")}
            </button>
          </div>
        )}

        {/* KPIs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          <Kpi
            label={tx("Open value", "قيمة المفتوح")}
            value={summary ? fmtMoney(summary.openValue, currency) : "—"}
            sub={tx("Across active deals", "عبر الصفقات النشطة")}
            icon={<IconBolt w={12} />}
          />
          <Kpi
            label={tx("Win rate", "نسبة الفوز")}
            value={summary ? String(summary.winRate) : "—"}
            unit="%"
            sub={
              summary
                ? `${summary.wonCount}W / ${summary.lostCount}L`
                : tx("—", "—")
            }
            icon={<IconCheckCircle w={12} />}
            tone="ok"
          />
          <Kpi
            label={tx("Avg time to close", "متوسط وقت الإغلاق")}
            value={summary ? String(summary.avgCloseHours) : "—"}
            unit="h"
            sub={tx("Created → terminal", "من الإنشاء حتى النهاية")}
            icon={<IconClock w={12} />}
          />
          <Kpi
            label={tx("Total tickets", "إجمالي التذاكر")}
            value={summary ? String(summary.totalTickets) : "—"}
            sub={tx("All time", "كل الأوقات")}
            icon={<IconUsers w={12} />}
          />
        </div>

        {/* Filter bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            background: "var(--bg-1)",
            border: "1px solid var(--line-soft)",
            borderRadius: 10,
            padding: "10px 12px",
          }}
        >
          <label style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)", textTransform: "uppercase" }}>
            {tx("Owner", "المسؤول")}
          </label>
          <select
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            style={{
              background: "var(--bg-2)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "var(--ink-1)",
              fontSize: 12,
              outline: "none",
            }}
          >
            <option value="">{tx("All", "الكل")}</option>
            {TEAM.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          <input
            type="search"
            placeholder={tx("Search title or contact…", "ابحث في العنوان أو العميل…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 200,
              background: "var(--bg-2)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "var(--ink-1)",
              fontSize: 13,
              outline: "none",
            }}
          />

          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)" }}
          >
            {filteredTickets.length} / {tickets.length}{" "}
            {tx("tickets", "تذكرة")}
          </span>

          <button className="btn ghost sm" onClick={resetFilters}>
            {tx("Reset", "إعادة")}
          </button>
        </div>

        {/* Kanban board */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, minmax(220px, 1fr))",
            gap: 12,
            alignItems: "start",
          }}
        >
          {GROUP_ORDER.map((g) => {
            const stages = stagesByGroup[g];
            const allCards = ticketsByGroup[g];
            const subFilter = activeStageFilter[g];
            const visibleCards = subFilter
              ? allCards.filter((c) => c.stageId === subFilter)
              : allCards;
            const sumValue = visibleCards.reduce(
              (acc, c) => acc + (c.value ?? 0),
              0,
            );
            const counts = new Map<string, number>();
            for (const c of allCards) {
              counts.set(c.stageId, (counts.get(c.stageId) ?? 0) + 1);
            }
            // Drop into the *first* stage of the group when group has only
            // one sub-stage; otherwise we drop on the actual sub-stage row.
            const singleStage = stages.length === 1 ? stages[0]! : null;

            return (
              <div
                key={g}
                className="card"
                style={{
                  background: "var(--bg-1)",
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 140,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--line-soft)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: "var(--ink)",
                      }}
                    >
                      {groupLabel(g, tx)}
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 11, color: "var(--ink-3)" }}
                    >
                      · {visibleCards.length}
                    </span>
                    {sumValue > 0 && (
                      <span
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginInlineStart: "auto",
                        }}
                      >
                        {fmtMoney(sumValue, currency)}
                      </span>
                    )}
                  </div>

                  {stages.length > 1 && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          setActiveStageFilter((m) => ({ ...m, [g]: null }))
                        }
                        className={`pl-chip ${subFilter === null ? "active" : ""}`.trim()}
                      >
                        {tx("All", "الكل")} {allCards.length}
                      </button>
                      {stages.map((s) => (
                        <button
                          type="button"
                          key={s.id}
                          onClick={() =>
                            setActiveStageFilter((m) => ({
                              ...m,
                              [g]: m[g] === s.id ? null : s.id,
                            }))
                          }
                          className={`pl-chip ${subFilter === s.id ? "active" : ""}`.trim()}
                        >
                          {(t.lang === "ar" ? s.labelAr : s.label) +
                            ` ${counts.get(s.id) ?? 0}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Drop zones — one per sub-stage */}
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 8,
                    minHeight: 80,
                  }}
                >
                  {(singleStage ? [singleStage] : stages).map((s) => {
                    const list = visibleCards.filter(
                      (c) => c.stageId === s.id,
                    );
                    const showSubHeader = !singleStage;
                    return (
                      <DroppableStage
                        key={s.id}
                        stageId={s.id}
                        cardIds={list.map((c) => c.id)}
                        showSubHeader={showSubHeader}
                      >
                        {showSubHeader && (
                          <div
                            className="mono"
                            style={{
                              fontSize: 10,
                              color: "var(--ink-3)",
                              textTransform: "uppercase",
                              letterSpacing: 0.06,
                              padding: "2px 4px",
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <span>
                              {t.lang === "ar" ? s.labelAr : s.label}
                            </span>
                            {s.isTerminal && !s.isWon && (
                              <span style={{ color: "var(--bad)" }}>·</span>
                            )}
                            {s.isWon && (
                              <span style={{ color: "var(--ok)" }}>·</span>
                            )}
                            <span style={{ marginInlineStart: "auto" }}>
                              {list.length}
                            </span>
                          </div>
                        )}
                        {list.map((card) => {
                          const owner = card.ownerId
                            ? TEAM.find((m) => m.id === card.ownerId)
                            : undefined;
                          return (
                            <DraggableTicketCard
                              key={card.id}
                              ticket={card}
                              stage={stageById.get(card.stageId)}
                              owner={owner}
                              tx={tx}
                              lang={t.lang}
                              onOpen={setSelectedId}
                              active={selectedId === card.id}
                            />
                          );
                        })}
                        {list.length === 0 && !showSubHeader && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--ink-3)",
                              textAlign: "center",
                              padding: 12,
                              opacity: 0.7,
                            }}
                          >
                            {tx("Drop here", "اسحب هنا")}
                          </div>
                        )}
                      </DroppableStage>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <DragOverlay>
          {activeDragId ? (() => {
            const t2 = tickets.find((tk) => tk.id === activeDragId);
            if (!t2) return null;
            const owner = t2.ownerId
              ? TEAM.find((m) => m.id === t2.ownerId)
              : undefined;
            return (
              <TicketCardView
                ticket={t2}
                stage={stageById.get(t2.stageId)}
                owner={owner}
                tx={tx}
                lang={t.lang}
                overlay
              />
            );
          })() : null}
        </DragOverlay>
        </DndContext>
      </div>

      {detail && (
        <DetailPanel
          detail={detail}
          notes={notesQ.data ?? []}
          owner={detailOwner}
          pipeline={detail.pipeline ?? activePipeline ?? undefined}
          tx={tx}
          lang={t.lang}
          onClose={() => setSelectedId(null)}
          onMarkWon={handleMarkWon}
          onMarkLost={handleMarkLost}
          onDelete={handleDelete}
          onAddNote={handleAddNote}
          noteSaving={addNote.isPending}
          busy={busy}
        />
      )}

      {selectedId && !detail && detailQ.loading && (
        <aside
          style={{
            position: "fixed",
            top: 56,
            bottom: 0,
            insetInlineEnd: 0,
            width: 380,
            background: "var(--bg-1)",
            borderInlineStart: "1px solid var(--line-soft)",
            display: "grid",
            placeItems: "center",
            zIndex: 8,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          {tx("Loading ticket…", "جارٍ تحميل التذكرة…")}
        </aside>
      )}

      {showNew && activePipeline && (
        <NewTicketModal
          pipeline={activePipeline}
          contacts={contacts}
          saving={createTicket.isPending}
          error={createTicket.error?.message ?? null}
          tx={tx}
          lang={t.lang}
          onClose={() => setShowNew(false)}
          onCreate={handleCreate}
        />
      )}

      {pendingLost && (
        <LostModal
          tx={tx}
          saving={moveTicket.isPending}
          onCancel={() => setPendingLost(null)}
          onConfirm={confirmLost}
        />
      )}

      <style>{`
        .pl-card {
          display: block;
          width: 100%;
          text-align: start;
          background: var(--bg-2);
          border: 1px solid var(--line-soft);
          border-radius: 10px;
          padding: 10px 12px;
          color: var(--ink);
          cursor: grab;
          transition: transform 0.08s ease, box-shadow 0.08s ease, border-color 0.08s ease;
        }
        .pl-card:hover { border-color: var(--line); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
        .pl-card:active { cursor: grabbing; }
        .pl-card.active { box-shadow: 0 0 0 2px var(--accent) inset; border-color: var(--accent-ring); }
        .pl-card.dragging { opacity: 0.25; }
        .pl-card.overlay {
          box-shadow: 0 12px 32px oklch(0 0 0 / 0.35), 0 0 0 1px var(--accent-ring);
          transform: rotate(-1.5deg);
          cursor: grabbing;
        }

        .pl-chip {
          display: inline-flex; align-items: center; gap: 4px;
          height: 22px; padding: 0 8px; border-radius: 999px;
          border: 1px solid var(--line-soft); background: var(--bg-1);
          color: var(--ink-3); font-size: 10px;
          font-family: var(--font-mono); cursor: pointer;
          letter-spacing: 0.02em;
        }
        .pl-chip:hover { color: var(--ink-1); border-color: var(--line); }
        .pl-chip.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent-ring); }

        .btn.sm { padding: 4px 10px; font-size: 12px; height: 28px; }
      `}</style>
    </div>
  );
}

const Pipeline = memo(PipelineImpl);
export default Pipeline;
