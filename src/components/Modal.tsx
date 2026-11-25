import { useRef, type CSSProperties, type ReactNode } from "react";
import { useDialogFocus } from "@/lib/useDialogFocus";

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  /** Max width of the panel. Default 440. */
  width?: number;
  /** Accessible label for the dialog. */
  label?: string;
  /** Merged into the panel style — e.g. `{ padding: 0 }` for panels that manage
   *  their own layout (grids, split panes). Overrides the defaults it names. */
  panelStyle?: CSSProperties;
  /** Higher stacking context for modals that open on top of another modal. */
  zIndex?: number;
  /** False: Escape and a backdrop click do nothing (e.g. a secret shown once
   *  and not yet copied); the screen's own buttons still close it. Default true. */
  dismissible?: boolean;
}

/**
 * Shared modal primitive. Replaces the fixed-overlay + stopPropagation +
 * Escape-handler scaffolding that was copy-pasted across ~13 screens. Handles:
 *  - click-outside to close (backdrop mousedown)
 *  - Escape to close, Tab kept inside, focus returned on close (useDialogFocus)
 *  - focus moves into the panel on open
 *  - stops propagation so clicks inside don't close it
 *
 * Screens can migrate to this incrementally; it doesn't change existing modals
 * until they adopt it.
 */
export function Modal({
  onClose,
  children,
  width = 440,
  label,
  panelStyle,
  zIndex = 100,
  dismissible = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // SP-30: the shared modal focus (useDialogFocus): focus moves to the panel,
  // Tab stays inside, Escape closes (when dismissible), and focus returns to
  // the opener on close.
  useDialogFocus(panelRef, true, () => {
    if (dismissible) onClose();
  }, { initialFocus: panelRef });

  return (
    <div
      role="presentation"
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "grid",
        placeItems: "center",
        zIndex,
        padding: 20,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        className="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line)",
          borderRadius: "var(--r)",
          padding: 20,
          width: "100%",
          maxWidth: width,
          maxHeight: "90vh",
          overflowY: "auto",
          outline: "none",
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
