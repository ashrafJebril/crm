import { memo } from "react";
import type { CSSProperties } from "react";
import { Avatar } from "@/components/Avatar";
import { IconInbox } from "@/icons";
import type { Ticket, Lang } from "@/lib/types";

interface TicketCardProps {
  ticket: Ticket;
  lang: Lang;
  isDragging?: boolean;
  onClick?: () => void;
  onOpenConversation?: () => void;
}

const cardStyle: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r)",
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  cursor: "grab",
  userSelect: "none",
};

export const TicketCard = memo(function TicketCard({
  ticket,
  lang,
  isDragging,
  onClick,
  onOpenConversation,
}: TicketCardProps) {
  const t = ticket;
  return (
    <div
      style={{
        ...cardStyle,
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDragging ? "var(--shadow-1)" : undefined,
      }}
      onClick={onClick}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.04 }}
        >
          #{String(t.number).padStart(3, "0")}
        </div>
        {t.conversationId ? (
          <button
            type="button"
            title={lang === "ar" ? "افتح المحادثة" : "Open conversation"}
            onClick={(e) => {
              e.stopPropagation();
              onOpenConversation?.();
            }}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--ink-3)",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <IconInbox w={14} />
          </button>
        ) : null}
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
