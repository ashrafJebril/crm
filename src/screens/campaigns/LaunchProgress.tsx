import type { Tx } from "@/lib/tx";
import type { Campaign } from "@/lib/types";
import { launchProgressView } from "./campaignDetailModel";

/**
 * SP-13 background launch: "Preparing" with the stage and counts (planned
 * recipients, batches done, direct messages sent) while `launching`; the
 * page polls the campaign every 5 s meanwhile. On failure, the stored
 * `lastError` worded. Cancel is offered while launching (campaigns.manage).
 */
export function LaunchProgress({
  tx,
  campaign,
  onCancel,
  cancelling,
  compact,
}: {
  tx: Tx;
  campaign: Pick<Campaign, "status" | "launchStage" | "sendTransport" | "lastError" | "launch" | "cancelRequestedAt" | "canCancel">;
  /** Omitted when the role may not cancel. */
  onCancel?: () => void;
  cancelling?: boolean;
  /** A list row: one line, no card. */
  compact?: boolean;
}) {
  const v = launchProgressView(campaign, tx);
  if (!v.active && !v.error) return null;
  const requested = !!campaign.cancelRequestedAt;

  if (compact) {
    return (
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
        {v.active ? [v.stage, ...v.lines].join(" · ") : v.error}
        {requested && v.active && ` · ${tx("Cancelling…", "جارٍ الإلغاء…")}`}
      </div>
    );
  }

  return (
    <section
      className="card"
      role="status"
      aria-live="polite"
      style={{ padding: "14px 18px", display: "grid", gap: 8, borderColor: v.active ? "var(--accent-ring)" : "var(--warn)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>
          {v.active ? tx("Preparing your campaign…", "جارٍ تجهيز حملتك…") : tx("The campaign couldn't start", "تعذّر بدء الحملة")}
        </strong>
        <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{v.stage}</span>
        <span style={{ flex: 1 }} />
        {v.active && onCancel && (
          <button type="button" className="btn sm danger" disabled={cancelling || requested} onClick={onCancel}>
            {requested ? tx("Cancelling…", "جارٍ الإلغاء…") : tx("Cancel", "إلغاء")}
          </button>
        )}
      </div>
      {v.lines.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", display: "flex", gap: 14, flexWrap: "wrap" }}>
          {v.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
      {v.pct !== null && (
        <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ width: `${v.pct}%`, height: "100%", background: "var(--accent)" }} />
        </div>
      )}
      {v.active && (
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          {tx("This keeps going if you leave the page.", "يستمر هذا حتى لو غادرت الصفحة.")}
        </div>
      )}
      {v.error && <div style={{ fontSize: 12.5, color: "var(--bad)" }}>{v.error}</div>}
    </section>
  );
}
