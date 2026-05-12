import { memo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { IconX } from "@/icons";
import type { ScheduledPost, ChannelResult } from "@/lib/types";

type StatusFilter = "all" | "pending" | "published" | "failed" | "canceled";

function parseChannels(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseResults(raw: string): Record<string, ChannelResult> {
  try {
    return (JSON.parse(raw) ?? {}) as Record<string, ChannelResult>;
  } catch {
    return {};
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusKind(s: ScheduledPost["status"]): "ok" | "bad" | "ai" | "" {
  if (s === "published") return "ok";
  if (s === "failed") return "bad";
  if (s === "publishing") return "ai";
  if (s === "pending") return "ai";
  return "";
}

function ScheduledImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const [filter, setFilter] = useState<StatusFilter>("all");
  const listQ = useFetch<ScheduledPost[]>(
    filter === "all" ? "/scheduled-posts" : `/scheduled-posts?status=${filter}`,
  );
  const cancelMut = useMutation<{ id: string }, ScheduledPost>((input) =>
    api.delete(`/scheduled-posts/${input.id}`),
  );

  const onCancel = async (post: ScheduledPost) => {
    if (
      !window.confirm(
        tx(
          "Cancel this scheduled post? It will not be published.",
          "إلغاء المنشور المجدول؟ لن يُنشر.",
        ),
      )
    )
      return;
    await cancelMut.mutate({ id: post.id });
    listQ.refetch();
  };

  const posts = listQ.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Scheduled posts", "المنشورات المجدولة")}
        subtitle={tx(
          "Posts queued for later, plus the recent publish history.",
          "المنشورات المجدولة وسجل النشر الحديث.",
        )}
      />

      <div style={{ padding: "10px 24px", display: "flex", gap: 6 }}>
        {(["all", "pending", "published", "failed", "canceled"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              padding: "4px 12px",
              borderRadius: 999,
              border: filter === f ? "1px solid var(--accent-ring)" : "1px solid var(--line-soft)",
              background: filter === f ? "var(--accent-soft)" : "var(--bg-2)",
              color: "var(--ink-1)",
              fontSize: 12,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {listQ.loading && posts.length === 0 && (
          <div className="mono muted pulse" style={{ fontSize: 12, padding: 12 }}>
            {tx("loading…", "جارٍ التحميل…")}
          </div>
        )}
        {!listQ.loading && posts.length === 0 && (
          <div
            className="mono muted"
            style={{
              fontSize: 13,
              padding: "32px 16px",
              textAlign: "center",
              border: "1px dashed var(--line-soft)",
              borderRadius: 12,
            }}
          >
            {tx("Nothing scheduled.", "لا توجد منشورات مجدولة.")}
          </div>
        )}
        {posts.map((p) => {
          const channels = parseChannels(p.channels);
          const results = parseResults(p.results);
          return (
            <div
              key={p.id}
              style={{
                border: "1px solid var(--line-soft)",
                borderRadius: 12,
                padding: 14,
                background: "var(--bg-1)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Badge kind={statusKind(p.status)} dot>
                  {p.status}
                </Badge>
                <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {p.status === "published" && p.publishedAt
                    ? `${tx("Published", "نُشر")}: ${formatWhen(p.publishedAt)}`
                    : `${tx("Scheduled for", "موعد النشر")}: ${formatWhen(p.scheduledFor)}`}
                </span>
                <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
                  {channels.map((ch) => (
                    <span
                      key={ch}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        background: ch === "facebook" ? "#1877F2" : "#E1306C",
                        color: "#fff",
                        fontSize: 10,
                        fontWeight: 500,
                      }}
                    >
                      {ch}
                    </span>
                  ))}
                </span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "var(--ink-1)",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.5,
                  display: "-webkit-box",
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {p.content}
              </div>
              {Object.keys(results).length > 0 && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    color: "var(--ink-3)",
                  }}
                >
                  {Object.entries(results).map(([ch, r]) => (
                    <span key={ch} style={{ color: r.ok ? "var(--ok)" : "var(--bad)" }}>
                      {ch}: {r.ok ? `✓ ${r.postId}` : `✗ ${r.error}`}
                    </span>
                  ))}
                </div>
              )}
              {p.lastError && p.status === "failed" && (
                <div style={{ color: "var(--bad)", fontSize: 11 }}>{p.lastError}</div>
              )}
              {p.status === "pending" && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onCancel(p)}
                    disabled={cancelMut.loading}
                    style={{ color: "var(--bad)" }}
                  >
                    <IconX w={12} />
                    {tx("Cancel", "إلغاء")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const Scheduled = memo(ScheduledImpl);
export default Scheduled;
