import { useRef, useState } from "react";
import type { Tx } from "@/lib/tx";

/**
 * A secret shown exactly once (an API key or a webhook signing secret), with
 * a Copy button. If the clipboard is unavailable (insecure context, denied),
 * the value is selected so it can be copied by hand.
 */
export function ShownOnce({ value, tx, label, onCopied }: { value: string; tx: Tx; label: string; onCopied?: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setState("copied");
      onCopied?.();
    } catch {
      ref.current?.focus();
      ref.current?.select();
      setState("manual");
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div role="alert" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--warn)" }}>
        {tx("Copy it now; you won't see it again", "انسخه الآن؛ لن يظهر مرة أخرى")}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <bdi dir="ltr" style={{ flex: 1, minWidth: 0 }}>
          <input
            ref={ref}
            readOnly
            aria-label={label}
            value={value}
            onFocus={(e) => e.currentTarget.select()}
            // A manual copy (Ctrl+C / ⌘C or the context menu) counts too.
            onCopy={() => onCopied?.()}
            style={{
              width: "100%",
              fontFamily: "var(--mono)",
              fontSize: 12,
              padding: "8px 10px",
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              color: "var(--ink)",
            }}
          />
        </bdi>
        <button type="button" className="btn primary" onClick={() => void copy()}>
          {state === "copied" ? tx("Copied", "تم النسخ") : tx("Copy", "نسخ")}
        </button>
      </div>
      {state === "manual" && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {tx("Copying failed. The value is selected: press Ctrl+C (⌘C) to copy it.", "تعذّر النسخ. القيمة محددة: اضغط Ctrl+C (⌘C) لنسخها.")}
        </div>
      )}
    </div>
  );
}
