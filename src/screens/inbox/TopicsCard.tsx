import type { Tx } from "@/lib/tx";

/** Non-empty strings, de-duplicated (they are used as React keys). */
export const clean = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== ""))] : [];

const Label = ({ children }: { children: string }) => (
  <div
    style={{
      fontSize: 10,
      fontFamily: "var(--font-mono)",
      textTransform: "uppercase",
      letterSpacing: 0.08,
      color: "var(--ink-3)",
    }}
  >
    {children}
  </div>
);

/** Topics and pain points from the AI resolution verdict. Renders nothing when
 *  the agent returned none. There is no translate button: the AI agent has no
 *  translate capability (see the SP-31 backend notes). */
export function TopicsCard({
  topics,
  painPoints,
  tx,
}: {
  topics?: string[] | null;
  painPoints?: string[] | null;
  tx: Tx;
}) {
  const t = clean(topics);
  const p = clean(painPoints);
  if (t.length === 0 && p.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {t.length > 0 && (
        <div>
          <Label>{tx("Topics", "المواضيع")}</Label>
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {t.map((x) => (
              <span
                key={x}
                dir="auto"
                style={{
                  padding: "2px 9px",
                  borderRadius: 999,
                  background: "var(--accent-soft)",
                  border: "1px solid var(--accent-ring)",
                  fontSize: 11.5,
                }}
              >
                {x}
              </span>
            ))}
          </div>
        </div>
      )}
      {p.length > 0 && (
        <div>
          <Label>{tx("Pain points", "نقاط الألم")}</Label>
          <ul dir="auto" style={{ margin: "8px 0 0", paddingInlineStart: 18, fontSize: 12, color: "var(--ink-2)", display: "grid", gap: 3 }}>
            {p.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
