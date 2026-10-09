import type { ReactNode } from "react";
import type { Tx } from "@/lib/tx";
import { IconMore, IconPhone } from "@/icons";

interface PhonePreviewProps {
  body: ReactNode;
  buttons?: string[];
  tx: Tx;
  /** Text direction of the message body (the phone chrome follows the app). */
  dir?: "ltr" | "rtl";
  /** Overrides the "Live preview" caption. */
  caption?: string;
  /** Rendered under the phone, e.g. a second channel's preview. */
  footer?: ReactNode;
}

/**
 * WhatsApp-style phone mockup used by the Campaigns wizard and the
 * Automations wizard. Sticky so it stays in view while the form scrolls.
 */
export function PhonePreview({ body, buttons = [], tx, dir, caption, footer }: PhonePreviewProps) {
  return (
    <div style={{ position: "sticky", top: 12, alignSelf: "start", display: "grid", gap: 14 }}>
      <div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--ink-3)",
            textTransform: "uppercase",
            marginBottom: 8,
            letterSpacing: 0.06,
          }}
        >
          {caption ?? tx("Live preview", "معاينة")}
        </div>
        <div
          style={{
            width: 320,
            maxWidth: "100%",
            background: "var(--bg-1)",
            border: "1px solid var(--line)",
            borderRadius: 28,
            padding: 14,
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 4px 12px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>Samemha</div>
              <div style={{ fontSize: 10, color: "var(--ok)" }}>● online</div>
            </div>
            <IconPhone w={14} className="muted" />
            <IconMore w={14} className="muted" />
          </div>
          <div
            style={{
              minHeight: 280,
              padding: "12px 0",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              backgroundImage: "radial-gradient(circle, var(--line-soft) 1px, transparent 1px)",
              backgroundSize: "16px 16px",
            }}
          >
            <div
              dir={dir}
              style={{
                alignSelf: "flex-start",
                maxWidth: "85%",
                padding: "8px 12px",
                background: "var(--bubble-out)",
                border: "1px solid var(--bubble-out-line)",
                borderRadius: "12px 12px 12px 4px",
                fontSize: 12.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {body}
              {buttons.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
                  {buttons.map((b) => (
                    <span
                      key={b}
                      style={{
                        padding: "3px 10px",
                        borderRadius: 999,
                        background: "var(--bg)",
                        border: "1px solid var(--line)",
                        fontSize: 11,
                      }}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              )}
              <div className="mono" style={{ fontSize: 9, color: "var(--ink-3)", textAlign: "end", marginTop: 4 }}>
                10:00 ✓
              </div>
            </div>
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}
