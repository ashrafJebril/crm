import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface LeadMenuItem {
  key: string;
  label: string;
  enabled: boolean;
  tip?: string;
  onPick: () => void;
}

interface Props {
  anchorRect: DOMRect;
  ariaLabel: string;
  items: LeadMenuItem[];
  onClose: () => void;
}

const MENU_W = 180;

/**
 * Card action menu rendered in a portal on document.body with fixed
 * positioning, so the column scroll area never clips it and later virtual
 * rows never paint over it. Click-away, Escape, and focus return to the trigger.
 */
export function LeadActionMenu({ anchorRect, ariaLabel, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";
  const rawLeft = rtl ? anchorRect.right - MENU_W : anchorRect.left;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - MENU_W - 8));
  const estHeight = items.length * 32 + 8;
  const below = anchorRect.bottom + 6;
  const top = below + estHeight > window.innerHeight ? Math.max(8, anchorRect.top - 6 - estHeight) : below;

  return createPortal(
    // Portal events bubble through the React tree to the card (drag + open drawer): stop them here.
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 199 }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={ariaLabel}
        style={{
          position: "fixed",
          top,
          left,
          width: MENU_W,
          zIndex: 200,
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          padding: 4,
        }}
      >
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            disabled={!it.enabled}
            title={it.enabled ? undefined : it.tip}
            onClick={() => {
              onClose();
              it.onPick();
            }}
            style={{
              display: "block",
              width: "100%",
              textAlign: "start",
              padding: "6px 8px",
              background: "transparent",
              border: 0,
              borderRadius: 6,
              color: "var(--ink)",
              fontSize: 12.5,
              cursor: it.enabled ? "pointer" : "not-allowed",
              opacity: it.enabled ? 1 : 0.5,
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
