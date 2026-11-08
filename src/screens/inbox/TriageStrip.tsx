import { useState } from "react";
import type { Tx } from "@/lib/tx";
import type { Contact, Conversation } from "@/lib/types";

/** Collapsible "Needs attention (n)" section above the rows. */
export function TriageStrip({
  items,
  contactById,
  activeId,
  onSelect,
  tx,
}: {
  items: Conversation[];
  contactById: Map<string, Contact>;
  activeId: string | null;
  onSelect: (id: string) => void;
  tx: Tx;
}) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <div style={{ margin: "0 12px 6px", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
      <button
        className="btn ghost sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", justifyContent: "space-between", color: "var(--warn)", fontWeight: 700 }}
      >
        <span>{tx("Needs attention", "تحتاج اهتمامًا")} ({items.length})</span>
        <span aria-hidden="true">{open ? "▾" : tx("▸", "◂")}</span>
      </button>
      {open && (
        <div>
          {items.map((c) => (
            <button
              key={c.id}
              className="btn ghost sm"
              onClick={() => onSelect(c.id)}
              aria-current={activeId === c.id}
              style={{
                display: "flex",
                width: "100%",
                justifyContent: "flex-start",
                textAlign: "start",
                gap: 6,
                fontWeight: activeId === c.id ? 700 : 400,
              }}
            >
              <span
                style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 auto", background: "var(--warn)" }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {contactById.get(c.contactId)?.name ?? c.preview}
              </span>
              {c.escalated && c.escalateReason && (
                <span
                  dir="auto"
                  title={c.escalateReason}
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    minWidth: 0,
                    flex: "0 1 auto",
                    maxWidth: 110,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.escalateReason}
                </span>
              )}
              {c.escalated && (
                <span style={{ fontSize: 10.5, color: "var(--bad)", marginInlineStart: "auto" }}>
                  {tx("Escalated", "مُصعَّدة")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
