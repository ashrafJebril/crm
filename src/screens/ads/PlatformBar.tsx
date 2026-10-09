import type { ComponentType } from "react";
import type { Tx } from "@/lib/tx";
import { IcAnalytics, IcGoogle, IcLock, IcMeta, IcSnap, IcTiktok } from "./icons";

interface Platform {
  id: string;
  label: (tx: Tx) => string;
  Icon: ComponentType<{ size?: number }>;
  locked: boolean;
}

// Meta is the ONLY backend (the provider port is Meta-only). The other four are
// rendered LOCKED — visible and honest, ready to flip to functional the day a
// backend exists. There is no platform state and no per-platform filtering:
// the prompt catalog is a flat Meta list.
const PLATFORMS: Platform[] = [
  { id: "meta", label: (tx) => tx("Meta", "ميتا"), Icon: IcMeta, locked: false },
  { id: "google", label: (tx) => tx("Google", "جوجل"), Icon: IcGoogle, locked: true },
  { id: "tiktok", label: (tx) => tx("TikTok", "تيك توك"), Icon: IcTiktok, locked: true },
  { id: "snap", label: (tx) => tx("Snapchat", "سناب"), Icon: IcSnap, locked: true },
  { id: "ga", label: (tx) => tx("Google Analytics", "جوجل أناليتكس"), Icon: IcAnalytics, locked: true },
];

/**
 * Platform switcher. Locked chips are plain <div>s — not buttons, no hover, no
 * click target — so there is nothing to press and nothing that could fire a
 * request. The lock glyph is the permanent "soon" signal; the reason rides on
 * aria-label + title for assistive tech and hover. Meta gets the live dot,
 * never a lock.
 */
export function PlatformBar({ tx }: { tx: Tx }) {
  const soon = tx("Soon — other platforms are coming.", "قريباً — المنصات الأخرى بتنضاف بعدين");
  return (
    <div className="ads-platbar">
      <div className="ads-plat-row">
        {PLATFORMS.map((pl) => {
          const active = !pl.locked;
          const label = pl.label(tx);
          return (
            <div
              key={pl.id}
              className={`ads-plat ${active ? "on" : "locked"}`}
              aria-label={active ? undefined : `${label} — ${soon}`}
              title={active ? undefined : soon}
            >
              <span className="glyph">
                <pl.Icon />
              </span>
              <span>{label}</span>
              {active ? <span className="live-dot" /> : <IcLock size={12} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
