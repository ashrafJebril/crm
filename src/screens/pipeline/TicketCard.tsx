import { memo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Avatar } from "@/components/Avatar";
import { IconInbox } from "@/icons";
import type { Ticket, Lang } from "@/lib/types";

interface TicketCardProps {
  ticket: Ticket;
  lang: Lang;
  accent?: string;
  onClick?: () => void;
  onOpenConversation?: () => void;
  onOpenMoveMenu?: (anchorRect: DOMRect) => void;
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
}: TicketCardProps) {
  const t = ticket;
  const moveBtnRef = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);

  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: t.id,
      data: { ticket: t },
    });

  const style: CSSProperties = {
    ...cardBase,
    cursor: isDragging ? "grabbing" : "grab",
    transform: CSS.Translate.toString(transform),
    visibility: isDragging ? "hidden" : "visible",
    touchAction: "none",
    borderColor: hovered
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
