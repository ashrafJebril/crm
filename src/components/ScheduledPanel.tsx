import { useEffect } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { IconX } from "@/icons";

interface ScheduledPost {
  id: string;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  scheduledFor: string | null;
}

/** Compact strip listing Zernio-scheduled posts with cancel. Renders nothing
 *  when the queue is empty, so the Social screen stays unchanged for most users. */
export function ScheduledPanel({ refreshKey }: { refreshKey: number }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const q = useFetch<ScheduledPost[]>("/social/scheduled");

  useEffect(() => {
    if (refreshKey > 0) q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const cancelMut = useMutation<{ id: string }, { ok: true }>(({ id }) =>
    api.delete(`/social/scheduled/${id}`),
  );

  const items = q.data ?? [];
  if (!items.length && !q.error) return null;

  return (
    <div style={{ padding: "12px 24px 0" }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          color: "var(--ink-3)",
          textTransform: "uppercase",
          letterSpacing: 0.06,
          marginBottom: 6,
        }}
      >
        {tx("Scheduled", "المجدولة")} · {items.length}
      </div>
      {q.error && (
        <div style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}>
          {tx("Couldn't load scheduled posts.", "تعذر تحميل المنشورات المجدولة.")}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {items.map((p) => (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 12px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 10,
              maxWidth: 420,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 260,
                }}
              >
                {p.content || tx("(no text)", "(بدون نص)")}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                {p.platforms.join(" · ")}
                {p.scheduledFor
                  ? ` — ${new Date(p.scheduledFor).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={tx("Cancel scheduled post", "إلغاء الجدولة")}
              disabled={cancelMut.loading}
              onClick={() => {
                void cancelMut.mutate({ id: p.id }).then(() => q.refetch()).catch(() => {});
              }}
            >
              <IconX w={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
