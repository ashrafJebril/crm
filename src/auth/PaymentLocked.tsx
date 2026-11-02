import { useAuth } from "@/auth/context";
import { billingLink } from "@/lib/paymentLock";
import { makeTx } from "@/lib/tx";
import { useTweaks } from "@/tweaks/context";

/** Shown instead of the app when the backend answers PAYMENT_OVERDUE. */
export function PaymentLocked() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { logout } = useAuth();
  const href = billingLink();

  return (
    <div
      role="alert"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        color: "var(--ink)",
        textAlign: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>
          {tx("Your workspace is locked", "مساحة العمل مقفلة")}
        </h1>
        <p style={{ color: "var(--ink-3)", fontSize: 14, margin: "0 0 20px" }}>
          {tx(
            "Payment is overdue. Settle your balance to get back in. Your data and queued work are safe.",
            "الدفع متأخر. سدّد المبلغ المستحق للعودة. بياناتك والأعمال المجدولة محفوظة.",
          )}
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {tx("Go to billing", "الذهاب إلى الفوترة")}
            </a>
          )}
          <button type="button" onClick={logout}>
            {tx("Sign out", "تسجيل الخروج")}
          </button>
        </div>
      </div>
    </div>
  );
}
