import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { Lang, TicketStage } from "@/lib/types";

interface Props {
  stages: TicketStage[];
  currentStageId: string;
  lang: Lang;
  anchorRect: DOMRect;
  onPick: (stage: TicketStage) => void;
  onClose: () => void;
}

const colorDot: Record<TicketStage["color"], string> = {
  ink: "var(--ink-3)",
  info: "var(--info, #3b82f6)",
  ok: "var(--ok, #10b981)",
  warn: "var(--warn, #f59e0b)",
  bad: "var(--bad, #ef4444)",
  accent: "var(--accent)",
  human: "var(--human, #8b5cf6)",
};

export function MoveStageMenu({
  stages,
  currentStageId,
  lang,
  anchorRect,
  onPick,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const menuStyle: CSSProperties = {
    position: "fixed",
    top: Math.min(anchorRect.bottom + 6, window.innerHeight - 320),
    left: Math.min(anchorRect.left, window.innerWidth - 240),
    minWidth: 220,
    maxHeight: 300,
    overflowY: "auto",
    background: "var(--bg-1)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    padding: 4,
    zIndex: 200,
  };

  return (
    <div ref={ref} role="menu" style={menuStyle}>
      <div
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          padding: "6px 10px",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {lang === "ar" ? "نقل إلى" : "Move to"}
      </div>
      {stages.map((s) => {
        const isCurrent = s.id === currentStageId;
        return (
          <button
            key={s.id}
            type="button"
            disabled={isCurrent}
            onClick={() => onPick(s)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              background: isCurrent ? "var(--bg-2)" : "transparent",
              border: 0,
              borderRadius: "var(--r)",
              color: isCurrent ? "var(--ink-3)" : "var(--ink)",
              fontSize: 13,
              textAlign: lang === "ar" ? "right" : "left",
              cursor: isCurrent ? "default" : "pointer",
              opacity: isCurrent ? 0.6 : 1,
            }}
            onMouseEnter={(e) => {
              if (!isCurrent) e.currentTarget.style.background = "var(--bg-2)";
            }}
            onMouseLeave={(e) => {
              if (!isCurrent) e.currentTarget.style.background = "transparent";
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: colorDot[s.color] ?? "var(--ink-3)",
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1 }}>{lang === "ar" ? s.labelAr : s.label}</span>
            {isCurrent ? (
              <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {lang === "ar" ? "الحالي" : "current"}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
