import type { ComponentType } from "react";
import type { Tx } from "@/lib/tx";
import type { AdsLocale, AdsTip } from "@/api/ads";
import { IcBolt, IcRefresh, IcTarget } from "./icons";

// Per-tip glyph + accent, applied by tip ORDER (the server sends three, in a
// fixed order). The two tints are the only colours on this screen that aren't a
// CRM token — see --ads-tip-* in ads-assistant.css.
const TIP_STYLES: { Icon: ComponentType<{ size?: number }>; tint: string; color: string }[] = [
  { Icon: IcTarget, tint: "var(--ads-tip-a-bg)", color: "var(--ads-tip-a)" },
  { Icon: IcRefresh, tint: "var(--ads-tip-b-bg)", color: "var(--ads-tip-b)" },
  { Icon: IcBolt, tint: "var(--ads-tip-a-bg)", color: "var(--ads-tip-a)" },
];

/** Server-authored tips, permanently parked at the bottom of the side column. */
export function TipsPanel({ tips, locale, tx }: { tips: AdsTip[]; locale: AdsLocale; tx: Tx }) {
  if (tips.length === 0) return null;
  return (
    <div className="ads-tips">
      <div className="heading">{tx("Tips for Better Results", "نصائح لنتائج أفضل")}</div>
      <div className="grid">
        {tips.map((tp, i) => {
          const st = TIP_STYLES[i % TIP_STYLES.length];
          return (
            <div key={tp.id} className="ads-tip">
              <div className="glyph" style={{ background: st.tint, color: st.color }}>
                <st.Icon />
              </div>
              <div className="t" dir="auto">
                {locale === "en" ? tp.titleEn : tp.titleAr}
              </div>
              <div className="b" dir="auto">
                {locale === "en" ? tp.bodyEn : tp.bodyAr}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
