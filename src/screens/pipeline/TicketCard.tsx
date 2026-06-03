import { memo, useRef } from "react";
import type { CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Avatar } from "@/components/Avatar";
import { IconInbox } from "@/icons";
import type { Ticket, Lang } from "@/lib/types";

interface TicketCardProps {
  ticket: Ticket;
  lang: Lang;
  onClick?: () => void;
  onOpenConversation?: () => void;
  onOpenMoveMenu?: (anchorRect: DOMRect) => void;
}

const cardBase: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  userSelect: "none",
  transition: "border-color 120ms, background 120ms",
};

const iconBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--ink-3)",
  cursor: "pointer",
  padding: 2,
  borderRadius: 4,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export const TicketCard = memo(function TicketCard({
  ticket,
  lang,
  onClick,
  onOpenConversation,
  onOpenMoveMenu,
}: TicketCardProps) {
  const t = ticket;
  const moveBtnRef = useRef<HTMLButtonElement | null>(null);

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: t.id,
      data: { ticket: t },
    });

  const style: CSSProperties = {
    ...cardBase,
    cursor: isDragging ? "grabbing" : "grab",
    transform: CSS.Translate.toString(transform),
    // Hide the source visually but keep its space — no "copy" appearance,
    // and dnd-kit still has a stable element to clean up against.
    visibility: isDragging ? "hidden" : "visible",
    touchAction: "none",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (isDragging) return;
        onClick?.();
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.04 }}
        >
          #{String(t.number).padStart(3, "0")}
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
            >
              <IconInbox w={14} />
            </button>
          ) : null}
          {onOpenMoveMenu ? (
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
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink-2)",
                padding: "2px 6px",
                border: "1px solid var(--line)",
                borderRadius: 999,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-1)";
                e.currentTarget.style.color = "var(--ink)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--ink-2)";
              }}
            >
              {lang === "ar" ? "نقل ▾" : "Move ▾"}
            </button>
          ) : null}
        </div>
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
        {t.title}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={t.contact?.name ?? "?"} size="sm" />
        <span
          style={{
            fontSize: 12,
            color: "var(--ink-2)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t.contact?.name ?? "—"}
        </span>
      </div>

      {t.value != null ? (
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-1)", fontWeight: 600 }}
        >
          {t.value.toLocaleString()} {t.currency ?? "SAR"}
        </div>
      ) : null}

      {t.ownerId ? (
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {lang === "ar" ? "المالك" : "Owner"}: {t.ownerId}
        </div>
      ) : null}
    </div>
  );
});

/** Static (non-draggable) version of the card used for the DragOverlay so the
 *  ghost doesn't fight with the source card's transform. */
export function TicketCardOverlay({
  ticket,
  lang,
}: {
  ticket: Ticket;
  lang: Lang;
}) {
  const t = ticket;
  return (
    <div
      style={{
        ...cardBase,
        cursor: "grabbing",
        boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
        background: "var(--bg-2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.04 }}
        >
          #{String(t.number).padStart(3, "0")}
        </div>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--ink)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {t.title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={t.contact?.name ?? "?"} size="sm" />
        <span
          style={{ fontSize: 12, color: "var(--ink-2)" }}
        >
          {t.contact?.name ?? "—"}
        </span>
      </div>
      {t.value != null ? (
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-1)", fontWeight: 600 }}
        >
          {t.value.toLocaleString()} {t.currency ?? "SAR"}
        </div>
      ) : null}
      {lang === "ar" ? null : null}
    </div>
  );
}
