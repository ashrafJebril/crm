import { useAuth } from "@/auth/context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconHand, IconX } from "@/icons";

/**
 * Renders a prominent banner at the very top of the app shell when the
 * current JWT is an impersonation session. The exit action just logs out —
 * the super-admin then logs back in as themselves to return.
 */
export function ImpersonationBanner() {
  const { impersonating, activeWorkspace, logout } = useAuth();
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  if (!impersonating) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        padding: "8px 16px",
        background: "oklch(0.72 0.18 35)",
        color: "#111",
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
      }}
    >
      <IconHand w={14} />
      <span style={{ flex: 1 }}>
        {tx(
          `Impersonating workspace: ${activeWorkspace?.name ?? "…"}. Actions you take are attributed to your super-admin account.`,
          `جلسة انتحال: ${activeWorkspace?.name ?? "…"}. الإجراءات تُنسب لحسابك كمشرف عام.`,
        )}
      </span>
      <button
        type="button"
        onClick={logout}
        style={{
          background: "rgba(0,0,0,0.18)",
          color: "#111",
          border: 0,
          padding: "4px 10px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <IconX w={11} />
        {tx("Exit impersonation", "إنهاء الجلسة")}
      </button>
    </div>
  );
}
