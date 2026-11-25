import { MediaPicker } from "@/components/media/MediaPicker";
import type { HeaderMediaKind } from "@/components/media/mediaKinds";
import type { Tx } from "@/lib/tx";

/** Days ahead a campaign with its own header file may be scheduled (ruling 9). */
export const HEADER_MEDIA_MAX_DAYS = 6;

/**
 * SP-13 campaign header file, for templates with a media header. By default
 * WhatsApp uses the template's approved sample file; "Choose another" picks a
 * library file. A chosen file sends every message individually (ruling 8), so
 * such a campaign reaches at most 5,000 people and can be scheduled at most
 * 6 days ahead.
 */
export function HeaderMediaField({
  tx,
  kind,
  value,
  onChange,
  override,
  onOverride,
}: {
  tx: Tx;
  kind: HeaderMediaKind;
  value: string | null;
  onChange: (id: string | null) => void;
  override: boolean;
  onOverride: (on: boolean) => void;
}) {
  const choice = (on: boolean, label: string) => (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
      <input
        type="radio"
        name="header-media-choice"
        checked={override === on}
        onChange={() => {
          onOverride(on);
          if (!on) onChange(null);
        }}
        style={{ accentColor: "var(--accent)" }}
      />
      {label}
    </label>
  );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 12, color: "var(--ink-2)", fontWeight: 500 }}>{tx("Header file", "ملف الترويسة")}</div>
      {choice(false, tx("Use the template's file", "استخدم ملف القالب"))}
      {choice(true, tx("Choose another", "اختر ملفًا آخر"))}
      {override && (
        <>
          <MediaPicker kind={kind} value={value} onChange={(m) => onChange(m?.id ?? null)} tx={tx} />
          <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
            {tx(
              `With its own header file, the campaign sends each message individually: up to 5,000 recipients, scheduled at most ${HEADER_MEDIA_MAX_DAYS} days ahead.`,
              `مع ملف ترويسة خاص، ترسل الحملة كل رسالة على حدة: حتى 5,000 مستلم، وجدولة قبل ${HEADER_MEDIA_MAX_DAYS} أيام على الأكثر.`,
            )}
          </div>
        </>
      )}
    </div>
  );
}
