import { useEffect, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { useAuth } from "@/auth/context";
import { makeTx } from "@/lib/tx";
import { IconX } from "@/icons";
import { bannersFor, dismissKey, type BannerKind } from "@/screens/billing/billingModel";
import { useBillingStatus } from "@/screens/billing/useBillingStatus";

const readDismissed = (key: string) => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

/**
 * SP-28 billing banners under the top bar, from GET /billing/status: a payment
 * due (counting down to the existing payment lock) for every member, and a low
 * or empty wallet for billing.view holders (the reduced status has no wallet).
 * The payment-due countdown is never dismissible; a dismissed wallet banner
 * stays hidden for the rest of the workspace's local day.
 */
export function BillingBanner() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const q = useBillingStatus();
  const tz = useAuth().activeWorkspace?.timezone;
  const [now, setNow] = useState(() => new Date());
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  // The payment-due countdown cannot be dismissed; wallet banners hide for the workspace's day.
  const banners = bannersFor(q.data, now).filter((b) => !b.dismissible || !readDismissed(dismissKey(b.kind, now, tz)));
  if (banners.length === 0) return null;
  const dismiss = (kind: BannerKind) => {
    try {
      localStorage.setItem(dismissKey(kind, now, tz), "1");
    } catch {
      /* storage blocked: hidden until the next render only */
    }
    setTick((n) => n + 1);
  };
  return (
    <div style={{ display: "grid", gap: 6, paddingInline: 24, paddingBlockStart: 8 }}>
      {banners.map((b) => (
        <div
          key={b.kind}
          role={b.tone === "bad" ? "alert" : "status"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingBlock: 8,
            paddingInline: 12,
            borderRadius: 8,
            fontSize: 13,
            border: `1px solid color-mix(in oklch, var(--${b.tone}) 45%, transparent)`,
            background: `color-mix(in oklch, var(--${b.tone}) 10%, var(--bg-1))`,
          }}
        >
          <span style={{ flex: 1 }}>{tx(b.text[0], b.text[1])}</span>
          {b.dismissible && (
            <button type="button" className="btn icon ghost sm" aria-label={tx("Dismiss for today", "إخفاء لليوم")} onClick={() => dismiss(b.kind)}>
              <IconX w={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
