import { useState } from "react";
import type { Tx } from "@/lib/tx";
import { chatPageUrl } from "./channelModel";
import { API_ORIGIN, CopyButton, fieldLabel } from "./channelUi";

/** The public hosted chat page (`{API}/api/chat/{id}`), with copy and open. */
export function ChatPageLink({ channelId, tx, disabled }: { channelId: string; tx: Tx; disabled?: boolean }) {
  const [lang, setLang] = useState<"" | "en" | "ar">("");
  const url = chatPageUrl(API_ORIGIN, channelId, lang || null);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={fieldLabel}>{tx("Chat page link", "رابط صفحة المحادثة")}</span>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as "" | "en" | "ar")}
          aria-label={tx("Link language", "لغة الرابط")}
          style={{ height: 26, fontSize: 12, background: "var(--bg-2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 6 }}
        >
          <option value="">{tx("Visitor's language", "لغة الزائر")}</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          background: "var(--bg-2)",
          borderRadius: 8,
          border: "1px solid var(--line-soft)",
        }}
      >
        <code style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11.5, overflowWrap: "anywhere" }}>
          <bdi dir="ltr">{url}</bdi>
        </code>
        <CopyButton text={url} tx={tx} />
        <a
          className="btn sm"
          href={disabled ? undefined : url}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={disabled || undefined}
          style={{ textDecoration: "none" }}
        >
          {tx("Open", "فتح")}
        </a>
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
        {tx(
          "Share this link anywhere (bio, email, QR code). It works without adding anything to your website.",
          "شارك هذا الرابط في أي مكان (النبذة، البريد، رمز QR). يعمل دون إضافة أي شيء إلى موقعك.",
        )}
      </div>
    </div>
  );
}
