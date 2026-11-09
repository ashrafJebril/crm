import { useState } from "react";
import { Modal } from "@/components/Modal";
import type { Tx } from "@/lib/tx";
import type { ChannelDto } from "@/lib/types";
import { buildSnippet } from "./channelModel";
import { API_ORIGIN, Banner, CopyButton } from "./channelUi";

/** The `<script>` embed for a website chat channel, with copy and install steps. */
export function WidgetSnippetDialog({ channel, tx, onClose }: { channel: ChannelDto; tx: Tx; onClose: () => void }) {
  const [lang, setLang] = useState<"" | "en" | "ar">("");
  const snippet = buildSnippet(API_ORIGIN, channel.id, lang || null);
  const origins = channel.config?.allowedOrigins ?? [];
  const title = tx("Add the chat to your website", "أضف المحادثة إلى موقعك");

  return (
    <Modal onClose={onClose} label={title} width={600} zIndex={120}>
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <div className="muted" style={{ fontSize: 12.5, marginBlockStart: 2 }}>
            {tx(
              "Paste this snippet on your site and the chat bubble goes live.",
              "الصق هذا المقطع في موقعك ليظهر زر المحادثة.",
            )}
          </div>
        </div>

        {origins.length === 0 && (
          <Banner tone="warn" title={tx("No allowed websites yet", "لا توجد مواقع مسموح بها بعد")}>
            {tx(
              "The chat only opens on websites listed in this channel's settings. Add your site (for example https://shop.example) first.",
              "تفتح المحادثة فقط على المواقع المدرجة في إعدادات هذه القناة. أضف موقعك أولًا (مثل https://shop.example).",
            )}
          </Banner>
        )}

        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
            {tx("Bubble language", "لغة الزر")}
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as "" | "en" | "ar")}
              style={{ height: 28, fontSize: 12, background: "var(--bg-2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 6 }}
            >
              <option value="">{tx("Channel setting", "إعداد القناة")}</option>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <CopyButton text={snippet} tx={tx} primary />
        </div>

        <pre
          dir="ltr"
          style={{
            margin: 0,
            padding: 12,
            borderRadius: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--line-soft)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            textAlign: "start",
          }}
        >
          <bdi dir="ltr">{snippet}</bdi>
        </pre>

        <ol style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 6, fontSize: 12.5, lineHeight: 1.5 }}>
          <li>{tx("Copy the snippet.", "انسخ المقطع.")}</li>
          <li>
            {tx(
              "Paste it just before </body>, or in your site builder's custom code section (Salla, WordPress and Shopify all have one).",
              "الصقه قبل ‎</body>‎ مباشرة، أو في قسم الكود المخصص في منشئ موقعك (سلة وووردبريس وشوبيفاي تدعم ذلك).",
            )}
          </li>
          <li>
            {tx(
              "Publish your site. The bubble appears on every page of the allowed websites.",
              "انشر موقعك. يظهر الزر في كل صفحات المواقع المسموح بها.",
            )}
          </li>
        </ol>

        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          {tx(
            "Sites with a strict Content-Security-Policy must allow this script and frame from ",
            "المواقع التي تستخدم سياسة أمان محتوى صارمة يجب أن تسمح بهذا السكربت والإطار من ",
          )}
          <bdi dir="ltr" className="mono">{API_ORIGIN}</bdi>
          {tx(". You can also open the chat from your own button with window.aramChat.open().", ". يمكنك أيضًا فتح المحادثة من زر خاص بك عبر window.aramChat.open().")}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            {tx("Done", "تم")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
