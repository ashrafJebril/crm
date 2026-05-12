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
