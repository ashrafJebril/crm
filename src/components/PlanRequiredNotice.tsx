import { useEffect, useState } from "react";
import { setPlanRequiredHandler, type PlanRequiredInfo } from "@/api/client";
import { usePermissions } from "@/auth/usePermissions";
import { Modal } from "@/components/Modal";
import { billingLink } from "@/lib/paymentLock";
import { makeTx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";
import { planGateView } from "@/screens/billing/planGate";

/**
 * SP-28: one friendly "Not in your plan" notice for any 402 PLAN_REQUIRED
 * (registered globally in client.ts; the caller's error toast stays quiet).
 * Kewy bills the workspace, so there is no checkout: billing viewers get the
 * Kewy billing link when one is configured, everyone else is told to contact
 * the workspace owner.
 */
export function PlanRequiredNotice() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can } = usePermissions();
  const [info, setInfo] = useState<PlanRequiredInfo | null>(null);
  useEffect(() => {
    setPlanRequiredHandler((i) => setInfo(i));
    return () => setPlanRequiredHandler(null);
  }, []);
  if (!info) return null;
  const v = planGateView(info, { canViewBilling: can("billing.view"), kewyBillingUrl: billingLink() });
  const close = () => setInfo(null);
  return (
    <Modal onClose={close} width={420} label={tx(v.title[0], v.title[1])}>
      <div dir={t.lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>{tx(v.title[0], v.title[1])}</h3>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)" }}>{tx(v.body[0], v.body[1])}</p>
        {v.action.kind === "contact_owner" && <p style={{ margin: 0, fontSize: 13 }}>{tx(v.action.label[0], v.action.label[1])}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={close}>
            {tx("Close", "إغلاق")}
          </button>
          {v.action.kind === "kewy" && (
            <a className="btn primary" href={v.action.href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
              {tx(v.action.label[0], v.action.label[1])}
            </a>
          )}
        </div>
      </div>
    </Modal>
  );
}
