import type { CSSProperties } from "react";

export const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: 0.06,
  marginBottom: 4,
};

export const FIELD_INPUT: CSSProperties = {
  width: "100%",
  height: 30,
  padding: "0 8px",
  borderRadius: 6,
  background: "var(--bg-1)",
  border: "1px solid var(--line-soft)",
  color: "var(--ink)",
  fontSize: 12.5,
  boxSizing: "border-box",
};

export const STATUS_ERROR: CSSProperties = { fontSize: 11.5, color: "var(--bad)", marginTop: 6 };

export const CARD: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-soft)",
  borderRadius: 8,
  padding: 10,
};
