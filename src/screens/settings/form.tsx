import type { CSSProperties, ReactNode } from "react";

/** Section card — a labeled block of form rows. */
export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--line-soft)",
        borderRadius: 12,
        padding: 18,
        marginBottom: 18,
      }}
    >
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        {description && (
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      {footer && (
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {footer}
        </div>
      )}
    </div>
  );
}

/** Field row — label on top, control below. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 11,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
        }}
      >
        {label}
      </span>
      {children}
      {hint && (
        <span className="muted" style={{ fontSize: 11 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  height: 38,
  padding: "0 12px",
  background: "var(--bg-2)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  color: "var(--ink)",
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
};

export function StatusToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        insetInlineEnd: 18,
        padding: "10px 14px",
        background: "var(--bg-elev)",
        border: "1px solid var(--line-soft)",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        fontSize: 13,
        zIndex: 60,
      }}
    >
      {message}
    </div>
  );
}

export function ErrorRow({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: 8,
        background: "oklch(0.7 0.22 24 / 0.12)",
        color: "var(--bad)",
        fontSize: 12,
        border: "1px solid oklch(0.7 0.22 24 / 0.35)",
      }}
    >
      {message}
    </div>
  );
}

/**
 * SP-29 sticky save bar: shown only while the form differs from what is
 * saved (or briefly after a save). It sticks to the block end of the
 * scrolling settings pane, announces its state politely, and keeps its
 * buttons at the inline end. The caller never renders it read-only (see
 * saveBarState).
 */
export function SaveBar({
  state,
  error,
  onSave,
  onDiscard,
  labels,
}: {
  state: "hidden" | "dirty" | "saving" | "saved" | "error";
  error?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  labels: { unsaved: string; discard: string; save: string; saving: string; saved: string; failed: string };
}) {
  if (state === "hidden") return null;
  const busy = state === "saving";
  const message =
    state === "saved" ? labels.saved : state === "saving" ? labels.saving : state === "error" ? labels.failed : labels.unsaved;
  return (
    <div
      role="region"
      aria-label={labels.unsaved}
      style={{
        position: "sticky",
        insetBlockEnd: 0,
        insetInlineStart: 0,
        insetInlineEnd: 0,
        zIndex: 20,
        marginBlockStart: 8,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        background: "var(--bg-elev)",
        border: `1px solid ${state === "error" ? "oklch(0.7 0.22 24 / 0.5)" : "var(--line-soft)"}`,
        borderRadius: 12,
        boxShadow: "var(--shadow-lg)",
        fontSize: 13,
      }}
    >
      <div style={{ flex: "1 1 200px", minWidth: 0, display: "grid", gap: 2 }}>
        <span aria-live="polite" style={{ fontWeight: 500, color: state === "error" ? "var(--bad)" : "var(--ink)" }}>
          {message}
        </span>
        {state === "error" && error ? (
          <span className="muted" style={{ fontSize: 12 }}>
            {error}
          </span>
        ) : null}
      </div>
      {state !== "saved" && (
        <div style={{ display: "flex", gap: 8, marginInlineStart: "auto" }}>
          <button type="button" className="btn ghost" onClick={onDiscard} disabled={busy}>
            {labels.discard}
          </button>
          <button type="button" className="btn primary" onClick={onSave} disabled={busy}>
            {busy ? labels.saving : labels.save}
          </button>
        </div>
      )}
    </div>
  );
}
