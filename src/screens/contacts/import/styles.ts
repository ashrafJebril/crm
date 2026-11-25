import type { CSSProperties } from "react";

export const FIELD: CSSProperties = {
  height: 32, padding: "0 10px", borderRadius: 8, background: "var(--bg-1)",
  border: "1px solid var(--line-soft)", color: "var(--ink)", fontSize: 13, outline: 0,
  fontFamily: "inherit", minWidth: 0,
};
export const LABEL: CSSProperties = { fontSize: 12, color: "var(--ink-3)", display: "block", marginBlockEnd: 4 };
export const ERROR_BOX: CSSProperties = {
  padding: "8px 12px", borderRadius: 8, fontSize: 12, color: "var(--bad)",
  background: "color-mix(in oklch, var(--bad) 12%, transparent)",
  border: "1px solid color-mix(in oklch, var(--bad) 32%, transparent)",
};
