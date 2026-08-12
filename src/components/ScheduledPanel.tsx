import { useEffect, useRef, useState } from "react";
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

/** How long a row stays armed for confirm before disarming on its own. */
const ARM_TIMEOUT_MS = 5000;

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

  // Cancel is a two-step inline confirm (no window.confirm): the first click
  // "arms" a row, the second executes. Only one row is ever armed at a time —
  // arming a different row implicitly disarms the previous one.
  const [armedId, setArmedId] = useState<string | null>(null);
  // The row currently mid-cancel (disables just that row's button).
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Cancel failures are surfaced inline on the row that failed, not silently
  // swallowed — errorRowId identifies which row cancelError belongs to.
  const [errorRowId, setErrorRowId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = () => {
    if (armTimer.current) {
      clearTimeout(armTimer.current);
      armTimer.current = null;
    }
    setArmedId(null);
  };

  // Belt-and-suspenders: clear any pending arm timer on unmount.
  useEffect(() => {
    return () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    };
  }, []);

  const armRow = (id: string) => {
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmedId(id);
    armTimer.current = setTimeout(() => {
      setArmedId(null);
      armTimer.current = null;
    }, ARM_TIMEOUT_MS);
  };

  const handleCancelClick = (id: string) => {
    if (cancellingId) return;
    if (armedId !== id) {
      // First click: arm this row, clear any stale error, disarm any other.
      setErrorRowId(null);
      setCancelError(null);
      armRow(id);
      return;
    }
    // Second click on the already-armed row: execute the cancel.
    disarm();
    setCancellingId(id);
    setErrorRowId(null);
    setCancelError(null);
    void cancelMut
      .mutate({ id })
      .then(() => {
        setCancellingId(null);
        q.refetch();
      })
      .catch(() => {
        setCancellingId(null);
        setErrorRowId(id);
        setCancelError(tx("Couldn't cancel this post.", "تعذر إلغاء هذا المنشور."));
      });
  };

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
        {items.map((p) => {
          const armed = armedId === p.id;
          const showError = errorRowId === p.id && !!cancelError;
          return (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 12px",
                background: "var(--bg-1)",
                border: showError ? "1px solid var(--bad)" : "1px solid var(--line-soft)",
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
                {showError && (
                  <div style={{ fontSize: 10.5, color: "var(--bad)", marginTop: 2 }}>
                    {cancelError}
                  </div>
                )}
              </div>
              <button
                type="button"
                className={armed ? "btn sm danger" : "btn ghost icon sm"}
                aria-label={
                  armed
                    ? tx("Confirm cancel", "تأكيد الإلغاء")
                    : tx("Cancel scheduled post", "إلغاء الجدولة")
                }
                disabled={cancellingId === p.id}
                onBlur={() => {
                  if (armed) disarm();
                }}
                onClick={() => handleCancelClick(p.id)}
                style={armed ? { whiteSpace: "nowrap", flexShrink: 0 } : undefined}
              >
                {armed ? tx("Confirm cancel", "تأكيد الإلغاء") : <IconX w={12} />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
