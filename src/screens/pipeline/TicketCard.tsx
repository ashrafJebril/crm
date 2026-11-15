import { memo, useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { usePermissions } from "@/auth/usePermissions";
import { CSS } from "@dnd-kit/utilities";
import { Avatar } from "@/components/Avatar";
import { IconInbox } from "@/icons";
import type { Ticket, Lang } from "@/lib/types";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { daysInStage } from "./stale";
import { NextStepChip, type NextStep } from "@/components/activities/NextStepChip";
import { LeadActionMenu } from "./LeadActionMenu";
import { useWorkspaceTz } from "@/components/activities/activityApi";
import { AttachmentCount, PriorityChip, SlaBadgeChip } from "./TicketBadges";
import { priorityChipShown } from "./ticketFields";
import { ticketSlaState } from "./ticketSla";

export type LeadAction = "won" | "lost" | "notALead" | "reopen";

interface TicketCardProps {
  ticket: Ticket;
  lang: Lang;
  accent?: string;
  onClick?: () => void;
  onOpenConversation?: () => void;
  onOpenMoveMenu?: (anchorRect: DOMRect) => void;
  nextStep?: NextStep;
  onNextStepClick?: () => void;
  /** Sat in this stage longer than the pipeline's stale threshold. */
  stale?: boolean;
  /** Moves disabled for this viewer (agentCanMove=false, no pipelines.update). */
  moveLocked?: boolean;
  /** Bulk selection state; the checkbox shows on hover or while anything is selected. */
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: (id: string) => void;
  /** Leads pipelines: Won / Lost / Not a lead / Reopen menu. */
  onLeadAction?: (ticket: Ticket, action: LeadAction) => void;
  /** SP-09: the column's stage is terminal (no SLA badge). */
  stageIsTerminal?: boolean;
}

const cardBase: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "10px 12px 12px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  userSelect: "none",
  position: "relative",
  transition: "border-color 140ms, background 140ms, transform 140ms, box-shadow 140ms",
};

const iconBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--ink-3)",
  cursor: "pointer",
  padding: 3,
  borderRadius: 4,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "color 120ms, background 120ms",
};

export const TicketCard = memo(function TicketCard({
  ticket,
  lang,
  accent = "var(--accent)",
  onClick,
  onOpenConversation,
  onOpenMoveMenu,
  nextStep,
  onNextStepClick,
  stale = false,
  moveLocked = false,
  selected = false,
  selectionActive = false,
  onToggleSelect,
  onLeadAction,
  stageIsTerminal,
}: TicketCardProps) {
  const { t: tw } = useTweaks();
  const tx = makeTx(tw.lang);
  const t = ticket;
  const moveBtnRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const leadBtnRef = useRef<HTMLButtonElement | null>(null);
  const [leadMenuRect, setLeadMenuRect] = useState<DOMRect | null>(null);
  const closeLeadMenu = useCallback(() => setLeadMenuRect(null), []);
  const canUpdate = usePermissions().can("tickets.update");
  const canMove = canUpdate && !moveLocked;
  const canNotLead = canUpdate && usePermissions().can("contacts.update");
  const closed = !!ticket.closedAt;
  const tz = useWorkspaceTz();
  const sla = ticketSlaState(t, stageIsTerminal);
  const showSupport = priorityChipShown(t.priority) || (sla !== "finished" && sla !== "none") || !!t.attachmentCount;
  const lockedTip = tx(
    "Only managers can move cards in this pipeline",
    "يمكن للمديرين فقط نقل البطاقات في هذا المسار",
  );

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: t.id,
      data: { ticket: t },
      disabled: !canMove,
    });

  const style: CSSProperties = {
    ...cardBase,
    cursor: !canMove ? (canUpdate && moveLocked ? "not-allowed" : "pointer") : isDragging ? "grabbing" : "grab",
    ...(stale
      ? {
          background: "color-mix(in srgb, var(--warn, #f59e0b) 10%, var(--bg-2))",
          border: "1px solid color-mix(in srgb, var(--warn, #f59e0b) 55%, var(--line))",
        }
      : {}),
    transform: CSS.Translate.toString(transform),
    visibility: isDragging ? "hidden" : "visible",
    touchAction: "none",
    borderColor: selected
      ? "var(--accent)"
      : stale
      ? "color-mix(in srgb, var(--warn, #f59e0b) 55%, var(--line))"
      : hovered
        ? `color-mix(in srgb, ${accent} 45%, var(--line))`
        : "var(--line)",
    boxShadow: hovered
      ? `0 2px 8px rgba(0,0,0,0.25), 0 0 0 1px color-mix(in srgb, ${accent} 30%, transparent)`
      : "0 1px 2px rgba(0,0,0,0.15)",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      title={canUpdate && moveLocked ? lockedTip : undefined}
      data-stale={stale ? "true" : undefined}
      {...attributes}
      {...listeners}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => {
        if (isDragging) return;
        onClick?.();
      }}
    >
      {/* Left color accent */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 8,
          bottom: 8,
          width: 3,
          background: accent,
          borderRadius: "0 2px 2px 0",
          opacity: 0.9,
        }}
      />

      {/* Header row: ticket number + actions */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
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
          {onToggleSelect && canUpdate && (hovered || selected || selectionActive) ? (
            <input
              type="checkbox"
              checked={selected}
              aria-label={tx(`Select ticket ${t.number}`, `تحديد التذكرة ${t.number}`)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect(t.id)}
              style={{ marginInlineEnd: 6, verticalAlign: "middle" }}
            />
          ) : null}
          <bdi>#{String(t.number).padStart(3, "0")}</bdi>
          {stale ? (
            <span
              style={{
                marginInlineStart: 6,
                fontSize: 10,
                fontWeight: 600,
                color: "var(--warn, #f59e0b)",
              }}
              title={tx("Stale: no movement past the pipeline's threshold", "راكدة: تجاوزت مدة الركود المحددة للمسار")}
            >
              {tx(`${daysInStage(t.enteredStageAt)}d in stage`, `${daysInStage(t.enteredStageAt)} يوم في المرحلة`)}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {t.conversationId ? (
            <button
              type="button"
              title={lang === "ar" ? "افتح المحادثة" : "Open conversation"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenConversation?.();
              }}
              style={iconBtn}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--ink)";
                e.currentTarget.style.background = "var(--bg-1)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--ink-3)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              <IconInbox w={13} />
            </button>
          ) : null}
          {onOpenMoveMenu && canMove ? (
            <button
              ref={moveBtnRef}
              type="button"
              title={lang === "ar" ? "نقل" : "Move"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (moveBtnRef.current) {
                  onOpenMoveMenu(moveBtnRef.current.getBoundingClientRect());
                }
              }}
              style={{
                ...iconBtn,
                fontSize: 10,
                fontWeight: 600,
                color: "var(--ink-2)",
                padding: "3px 8px",
                background: "var(--bg-1)",
                border: "1px solid var(--line)",
                borderRadius: 999,
                letterSpacing: 0.04,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background =
                  `color-mix(in srgb, ${accent} 12%, var(--bg-1))`;
                e.currentTarget.style.borderColor =
                  `color-mix(in srgb, ${accent} 40%, var(--line))`;
                e.currentTarget.style.color = "var(--ink)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-1)";
                e.currentTarget.style.borderColor = "var(--line)";
                e.currentTarget.style.color = "var(--ink-2)";
              }}
            >
              {lang === "ar" ? "نقل ▾" : "Move ▾"}
            </button>
          ) : null}
          {onLeadAction && canUpdate ? (
            <>
              <button
                ref={leadBtnRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={leadMenuRect != null}
                aria-label={tx("Card actions", "إجراءات البطاقة")}
                title={tx("Card actions", "إجراءات البطاقة")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (leadBtnRef.current) setLeadMenuRect(leadBtnRef.current.getBoundingClientRect());
                }}
                style={iconBtn}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              {leadMenuRect ? (
                <LeadActionMenu
                  anchorRect={leadMenuRect}
                  ariaLabel={tx("Card actions", "إجراءات البطاقة")}
                  onClose={closeLeadMenu}
                  items={
                    closed
                      ? [{ key: "reopen", label: tx("Reopen", "إعادة فتح"), enabled: canMove, tip: lockedTip, onPick: () => onLeadAction(t, "reopen") }]
                      : [
                          { key: "won", label: tx("Won", "رابحة"), enabled: canMove, tip: lockedTip, onPick: () => onLeadAction(t, "won") },
                          { key: "lost", label: tx("Lost", "خاسرة"), enabled: canMove, tip: lockedTip, onPick: () => onLeadAction(t, "lost") },
                          {
                            key: "notALead",
                            label: tx("Not a lead", "ليس عميلاً محتملاً"),
                            enabled: canNotLead && canMove,
                            tip: canNotLead ? lockedTip : tx("You don't have permission", "ليس لديك صلاحية"),
                            onPick: () => onLeadAction(t, "notALead"),
                          },
                        ]
                  }
                />
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {/* Title — gets the most visual weight */}
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          lineHeight: 1.35,
          color: "var(--ink)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          textOverflow: "ellipsis",
          letterSpacing: -0.1,
        }}
      >
        {t.title}
      </div>

      {/* SP-09: priority (high/urgent), SLA badge, attachment count */}
      {showSupport ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <PriorityChip tx={tx} priority={t.priority} />
          <SlaBadgeChip tx={tx} tz={tz} ticket={t} stageIsTerminal={stageIsTerminal} />
          <span style={{ marginInlineStart: "auto" }}>
            <AttachmentCount tx={tx} count={t.attachmentCount} />
          </span>
        </div>
      ) : null}

      {/* Footer: contact + value */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 2,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
          }}
        >
          <Avatar name={t.contact?.name ?? "?"} size="sm" />
          <span
            style={{
              fontSize: 11.5,
              color: "var(--ink-2)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 500,
            }}
          >
            {t.contact?.name ?? "—"}
          </span>
        </div>
        {t.value != null ? (
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-1)",
              padding: "2px 6px",
              background: `color-mix(in srgb, ${accent} 10%, transparent)`,
              borderRadius: 6,
              border: `1px solid color-mix(in srgb, ${accent} 22%, transparent)`,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {t.value >= 1000
              ? `${(t.value / 1000).toFixed(1)}k`
              : t.value.toLocaleString()}{" "}
            {t.currency ?? "SAR"}
          </div>
        ) : null}
      </div>

      {/* Next step (batch-loaded per column) */}
      <div style={{ minWidth: 0 }}>
        <NextStepChip step={nextStep} canEdit={canMove} onClick={onNextStepClick} />
      </div>
    </div>
  );
});

/** Static overlay version — no draggable wiring, used as the drag ghost. */
export function TicketCardOverlay({
  ticket,
  lang,
  accent = "var(--accent)",
}: {
  ticket: Ticket;
  lang: Lang;
  accent?: string;
}) {
  const t = ticket;
  return (
    <div
      style={{
        ...cardBase,
        cursor: "grabbing",
        boxShadow: `0 16px 40px rgba(0,0,0,0.55), 0 0 0 1px ${accent}`,
        borderColor: `color-mix(in srgb, ${accent} 60%, var(--line))`,
        transform: "rotate(-1.5deg)",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 8,
          bottom: 8,
          width: 3,
          background: accent,
          borderRadius: "0 2px 2px 0",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.06 }}
        >
          #{String(t.number).padStart(3, "0")}
        </div>
      </div>
      <div
        style={{
          fontSize: 13.5,
          fontWeight: 600,
          color: "var(--ink)",
          lineHeight: 1.35,
        }}
      >
        {t.title}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Avatar name={t.contact?.name ?? "?"} size="sm" />
          <span style={{ fontSize: 11.5, color: "var(--ink-2)", fontWeight: 500 }}>
            {t.contact?.name ?? "—"}
          </span>
        </div>
        {t.value != null ? (
          <div
            className="mono"
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-1)",
              padding: "2px 6px",
              background: `color-mix(in srgb, ${accent} 10%, transparent)`,
              borderRadius: 6,
              border: `1px solid color-mix(in srgb, ${accent} 22%, transparent)`,
            }}
          >
            {t.value >= 1000 ? `${(t.value / 1000).toFixed(1)}k` : t.value.toLocaleString()}{" "}
            {t.currency ?? "SAR"}
          </div>
        ) : null}
      </div>
      {lang === "ar" ? null : null}
    </div>
  );
}
