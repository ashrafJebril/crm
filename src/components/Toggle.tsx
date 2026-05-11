interface ToggleProps {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}

export const Toggle = ({ on, onChange, label }: ToggleProps) => (
  <button
    type="button"
    onClick={() => onChange(!on)}
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      background: "transparent",
      border: 0,
      cursor: "pointer",
      color: "inherit",
      padding: 0,
    }}
  >
    <span
      style={{
        width: 30,
        height: 18,
        borderRadius: 999,
        background: on ? "var(--accent)" : "var(--bg-3)",
        position: "relative",
        transition: "background 0.15s",
        border: "1px solid var(--line)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 1,
          insetInlineStart: on ? 13 : 1,
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: on ? "var(--accent-ink)" : "var(--ink-2)",
          transition: "inset-inline-start 0.15s",
        }}
      />
    </span>
    {label && <span style={{ fontSize: 13 }}>{label}</span>}
  </button>
);
