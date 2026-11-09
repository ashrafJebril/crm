import type { Tx } from "@/lib/tx";
import type { SendersResponse } from "@/lib/types";
import { effectiveSelection, makePrimary, senderUnavailable, splitCounts, toggleSender } from "./senderModel";
import { fmtNum } from "./ui";

/**
 * SP-13 "Send from": tick one or more WhatsApp numbers. The first ticked is
 * the primary (it holds the template copy and skipped rows; "Make primary"
 * moves one to the front). Numbers that can't send campaigns are listed
 * disabled with the reason. Recipients split round-robin across the ticked
 * numbers; the estimate uses the backend's closed form.
 */
export function SendFromField({
  tx,
  senders,
  value,
  onChange,
  audienceCount,
}: {
  tx: Tx;
  senders: SendersResponse;
  /** Ticked numbers in order; [] = the default number. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Reachable recipients when known, for the split estimate. */
  audienceCount: number | null;
}) {
  const ids = effectiveSelection(value, senders.senders);
  const limit = Math.max(1, senders.limit);
  const counts = audienceCount && audienceCount > 0 ? splitCounts(audienceCount, ids) : null;
  // Ticked first (in send order), then the rest as listed.
  const ordered = [
    ...ids.map((id) => senders.senders.find((s) => s.channelId === id)).filter((s) => !!s),
    ...senders.senders.filter((s) => !ids.includes(s.channelId)),
  ];

  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h3>{tx("Send from", "الإرسال من")}</h3>
          <div className="sub">
            {tx(
              `Recipients are shared in turn across the ticked numbers. Up to ${limit} on your plan.`,
              `يُوزَّع المستلمون بالتناوب على الأرقام المحددة. حتى ${limit} حسب خطتك.`,
            )}
          </div>
        </div>
      </div>
      <div style={{ padding: 18, display: "grid", gap: 8 }}>
        {ordered.map((s) => {
          const on = ids.includes(s.channelId);
          const pos = ids.indexOf(s.channelId);
          const why = senderUnavailable(s, tx);
          const atLimit = !on && ids.length >= limit && limit > 1;
          return (
            <div
              key={s.channelId}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: 10,
                borderRadius: 10,
                background: on ? "var(--accent-soft)" : "var(--bg-1)",
                border: `1px solid ${on ? "var(--accent-ring)" : "var(--line-soft)"}`,
                opacity: why ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!!why || atLimit || (on && ids.length === 1)}
                onChange={() => onChange(toggleSender(ids, s.channelId, limit))}
                aria-label={s.displayName}
                title={why ?? (atLimit ? tx(`Up to ${limit} numbers on your plan`, `حتى ${limit} أرقام حسب خطتك`) : undefined)}
                style={{ accentColor: "var(--accent)" }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span dir="auto">{s.displayName}</span>
                  {s.phoneNumber && (
                    <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                      <bdi dir="ltr">{s.phoneNumber}</bdi>
                    </span>
                  )}
                  {pos === 0 && ids.length > 1 && (
                    <span className="badge accent">{tx("Primary", "الأساسي")}</span>
                  )}
                  {s.isDefault && <span className="badge">{tx("Default", "الافتراضي")}</span>}
                </div>
                {why && <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>{why}</div>}
              </div>
              {on && counts && (
                <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
                  ≈ {fmtNum(counts[pos] ?? 0)}
                </span>
              )}
              {on && pos > 0 && (
                <button type="button" className="btn ghost sm" onClick={() => onChange(makePrimary(ids, s.channelId))}>
                  {tx("Make primary", "اجعله الأساسي")}
                </button>
              )}
            </div>
          );
        })}
        {ids.length > 1 && (
          <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {tx(
              "Every ticked number must have the template approved. The review step checks this.",
              "يجب أن يكون القالب معتمدًا على كل رقم محدد. تتحقق خطوة المراجعة من ذلك.",
            )}
          </div>
        )}
      </div>
    </div>
  );
}
