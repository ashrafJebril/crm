import type { Tx } from "@/lib/tx";
import type { NumberTotals } from "@/lib/types";
import { showNumberTable } from "./senderModel";
import { Card, fmtNum } from "./ui";

/**
 * SP-13 report: outcomes per sending number (`insights.byNumber`, largest
 * first). Shown with more than one number, or one that is not the default
 * (Tkana's showNumberTable). A deleted channel reads "Unknown number".
 */
export function NumberSplitCard({
  tx,
  byNumber,
  defaultChannelId,
}: {
  tx: Tx;
  byNumber: readonly NumberTotals[] | undefined;
  defaultChannelId: string | null;
}) {
  const rows = byNumber ?? [];
  if (!showNumberTable(rows, defaultChannelId)) return null;
  const cols: { key: keyof NumberTotals; label: string }[] = [
    { key: "total", label: tx("Recipients", "المستلمون") },
    { key: "sent", label: tx("Attempted", "تمت المحاولة") },
    { key: "delivered", label: tx("Delivered", "وصلت") },
    { key: "read", label: tx("Read", "قُرئت") },
    { key: "replied", label: tx("Replied", "ردّوا") },
    { key: "failed", label: tx("Failed", "فشلت") },
    { key: "skipped", label: tx("Skipped", "مُستبعد") },
  ];
  return (
    <Card title={tx("By sending number", "حسب رقم الإرسال")}>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>{tx("Number", "الرقم")}</th>
              {cols.map((c) => (
                <th key={c.key} style={{ textAlign: "end" }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.channelId ?? `unknown-${i}`}>
                <td>
                  {r.unknown || !r.channelId ? (
                    <span style={{ color: "var(--ink-3)" }}>{tx("Unknown number", "رقم غير معروف")}</span>
                  ) : (
                    <>
                      <span dir="auto">{r.displayName ?? "—"}</span>
                      {r.phoneNumber && (
                        <span className="mono" style={{ marginInlineStart: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
                          <bdi dir="ltr">{r.phoneNumber}</bdi>
                        </span>
                      )}
                    </>
                  )}
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="mono" style={{ textAlign: "end" }}>
                    {fmtNum(r[c.key] as number)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
