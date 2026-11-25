import type { Tx } from "@/lib/tx";
import type { ChannelLimits } from "@/lib/types";
import { limitView } from "./channelModel";

/** WhatsApp numbers used vs the plan limit (GET /channels/limits). */
export function NumberLimitNotice({ limits, tx, compact }: { limits: ChannelLimits | null; tx: Tx; compact?: boolean }) {
  const v = limitView(limits);
  if (!v) return null;
  const atLimit = v.state === "at_limit";
  return (
    <div
      role={atLimit ? "status" : undefined}
      style={{
        display: "grid",
        gap: 6,
        padding: compact ? 0 : "10px 12px",
        borderRadius: 10,
        background: compact ? "transparent" : "var(--bg-2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5 }}>
        <span>{tx(v.en, v.ar)}</span>
        {atLimit && <span style={{ color: "var(--warn)", fontWeight: 600 }}>{tx("Limit reached", "تم بلوغ الحد")}</span>}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={v.limit}
        aria-valuenow={v.used}
        aria-label={tx("WhatsApp numbers used", "أرقام واتساب المستخدمة")}
        style={{ height: 6, borderRadius: 3, background: "var(--line-soft)", overflow: "hidden" }}
      >
        <div
          style={{
            width: `${v.percent}%`,
            height: "100%",
            background: atLimit ? "var(--warn)" : "var(--accent)",
          }}
        />
      </div>
      {atLimit && !compact && (
        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          {tx(
            "To add another WhatsApp number, disconnect one you no longer use (pending numbers count too) or upgrade your plan. Reconnecting a number you already hold is always allowed.",
            "لإضافة رقم واتساب آخر، افصل رقمًا لم تعد تستخدمه (تُحتسب الأرقام قيد الانتظار أيضًا) أو رقِّ باقتك. إعادة ربط رقم لديك مسموحة دائمًا.",
          )}
        </div>
      )}
    </div>
  );
}
