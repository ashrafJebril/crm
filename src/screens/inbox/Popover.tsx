import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Toolbar popover: focuses the first control on open; Escape (from trigger or
 *  panel) closes and returns focus to the trigger. Same pattern as the thread menus. */
export function Popover({
  trigger,
  title,
  ariaLabel,
  role,
  badge,
  disabled,
  triggerClassName = "btn ghost icon sm",
  panelStyle,
  sheetOnPhone = false,
  children,
}: {
  trigger: ReactNode;
  title?: string;
  ariaLabel?: string;
  /** Omit for a plain action menu (aria-haspopup="true", no panel role). */
  role?: "menu" | "dialog";
  badge?: number;
  disabled?: boolean;
  triggerClassName?: string;
  panelStyle?: CSSProperties;
  /** SP-30: below md the panel is a bottom sheet (the inbox filters and sort). */
  sheetOnPhone?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) {
      panelRef.current
        ?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")
        ?.focus();
    }
  }, [open]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div
      style={{ position: "relative" }}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <span title={title} style={{ display: "inline-flex" }}>
      <button
        ref={triggerRef}
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel && badge ? `${ariaLabel} (${badge})` : ariaLabel}
        aria-haspopup={role ?? "true"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ position: "relative" }}
      >
        {trigger}
        {!!badge && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              insetInlineEnd: -4,
              top: -4,
              minWidth: 14,
              height: 14,
              borderRadius: 99,
              background: "var(--accent)",
              color: "var(--bg-1)",
              fontSize: 9.5,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
            }}
          >
            {badge}
          </span>
        )}
      </button>
      </span>
      {open && !disabled && (
        <>
          <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div
            ref={panelRef}
            className={sheetOnPhone ? "ix-popover-sheet" : undefined}
            role={role}
            aria-label={ariaLabel}
            onKeyDown={(e) => {
              if (role !== "dialog" && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                const items = Array.from(panelRef.current?.querySelectorAll("button") ?? []);
                const i = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = e.key === "ArrowDown" ? i + 1 : i - 1;
                items[(next + items.length) % items.length]?.focus();
              }
            }}
            style={{
              position: "absolute",
              insetInlineEnd: 0,
              top: "calc(100% + 4px)",
              zIndex: 41,
              minWidth: 220,
              maxHeight: 420,
              overflowY: "auto",
              padding: 8,
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,.18)",
              ...panelStyle,
            }}
          >
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}
