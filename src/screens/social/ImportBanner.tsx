import { useEffect, useState } from "react";
import type { Tx } from "@/lib/tx";
import { importProgress, type PlatformImportStatus } from "./importProgress";

/**
 * "Importing posts from Facebook" strip shown on a feed tab while Zernio is
 * still backfilling a newly connected account. Re-renders every 30s so the
 * minute counters and bar move between the 2-minute data polls.
 */
export function ImportBanner({
  status,
  platformLabel,
  postsShown,
  tx,
}: {
  status: PlatformImportStatus | undefined;
  platformLabel: string;
  postsShown: number;
  tx: Tx;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const p = importProgress(status, now);
  if (!p) return null;

  const count = Math.max(postsShown, status?.postCount ?? 0);
  const timing = p.overdue
    ? tx("taking longer than usual — still checking", "يستغرق وقتًا أطول من المعتاد — ما زلنا نتحقق")
    : tx(`about ${p.minutesLeft} min left`, `تبقّى حوالي ${p.minutesLeft} دقيقة`);
  const sync =
    p.minutesSinceSync === null
      ? tx("waiting for first sync", "بانتظار أول مزامنة")
      : tx(`last synced ${p.minutesSinceSync} min ago`, `آخر مزامنة قبل ${p.minutesSinceSync} دقيقة`);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--line-soft)",
        background: "var(--bg-1)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-2)" }}>
        {tx(
          `Importing your existing posts from ${platformLabel} · ${count} so far`,
          `جارٍ استيراد منشوراتك من ${platformLabel} · ${count} حتى الآن`,
        )}
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p.percent}
        aria-label={tx("Import progress", "تقدّم الاستيراد")}
        style={{ height: 4, borderRadius: 999, background: "var(--line-soft)", overflow: "hidden" }}
      >
        <div
          style={{
            width: `${p.percent}%`,
            height: "100%",
            background: "var(--accent, var(--ok))",
            transition: "width 600ms ease",
          }}
        />
      </div>
      <div className="mono muted" style={{ fontSize: 11 }}>
        {tx(
          `Connected ${p.minutesSinceConnect} min ago · ${timing} · ${sync}`,
          `تم الربط قبل ${p.minutesSinceConnect} دقيقة · ${timing} · ${sync}`,
        )}
      </div>
      <div className="mono muted" style={{ fontSize: 11 }}>
        {tx(
          "Zernio imports a page's existing posts within ~90 min. New posts appear here automatically.",
          "يستورد Zernio منشورات الصفحة الحالية خلال ~٩٠ دقيقة. ستظهر المنشورات هنا تلقائيًا.",
        )}
      </div>
    </div>
  );
}
