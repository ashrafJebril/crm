import { useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import { SchedulePicker } from "@/components/SchedulePicker";
import { IconChev } from "@/icons";

interface ScheduledRow {
  id: string;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  scheduledFor: string | null;
}
interface PublishedRow {
  id: string;
  platform: string;
  body: string;
  mediaUrl: string | null;
  createdAt: string | null;
  permalink: string | null;
}
interface CalItem {
  key: string;
  kind: "scheduled" | "published";
  id: string;
  date: Date;
  content: string;
  platforms: string[];
  mediaUrl: string | null;
  permalink: string | null;
}

/** ISO date (YYYY-MM-DD) in LOCAL time — calendar cells bucket by local day. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 6 rows x 7 cols of Dates covering the month, weeks starting Sunday —
 *  matches the appointments Calendar screen's convention. */
function buildMonthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const weeks: Date[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < 6; w += 1) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

export function ContentCalendar({ refreshKey }: { refreshKey: number }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);

  const scheduledQ = useFetch<ScheduledRow[]>(`/social/scheduled?rk=${refreshKey}`);
  const publishedQ = useFetch<PublishedRow[]>("/integrations/zernio/posts");

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalItem | null>(null);

  const items: CalItem[] = useMemo(() => {
    const out: CalItem[] = [];
    for (const s of scheduledQ.data ?? []) {
      if (!s.scheduledFor) continue;
      out.push({
        key: `s-${s.id}`,
        kind: "scheduled",
        id: s.id,
        date: new Date(s.scheduledFor),
        content: s.content,
        platforms: s.platforms,
        mediaUrl: s.mediaUrl,
        permalink: null,
      });
    }
    for (const p of publishedQ.data ?? []) {
      if (!p.createdAt) continue;
      out.push({
        key: `p-${p.platform}-${p.id}`,
        kind: "published",
        id: p.id,
        date: new Date(p.createdAt),
        content: p.body,
        platforms: [p.platform],
        mediaUrl: p.mediaUrl,
        permalink: p.permalink,
      });
    }
    return out;
  }, [scheduledQ.data, publishedQ.data]);

  const byDay = useMemo(() => {
    const m = new Map<string, CalItem[]>();
    for (const it of items) {
      const k = localDayKey(it.date);
      const list = m.get(k) ?? [];
      list.push(it);
      m.set(k, list);
    }
    for (const list of m.values()) {
      list.sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    return m;
  }, [items]);

  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const monthLabel = new Date(year, month, 1).toLocaleDateString(
    t.lang === "ar" ? "ar" : undefined,
    { month: "long", year: "numeric" },
  );
  const todayKey = localDayKey(new Date());

  const nav = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setExpandedDay(null);
  };

  const refetchAll = () => {
    scheduledQ.refetch();
    publishedQ.refetch();
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <button type="button" className="btn ghost icon sm" onClick={() => nav(-1)} aria-label={tx("Previous month", "الشهر السابق")}>
          <IconChev w={14} className="flip-rtl" style={{ transform: "rotate(180deg)" }} />
        </button>
        <span style={{ fontWeight: 600, fontSize: 14, minWidth: 140, textAlign: "center" }}>{monthLabel}</span>
        <button type="button" className="btn ghost icon sm" onClick={() => nav(1)} aria-label={tx("Next month", "الشهر التالي")}>
          <IconChev w={14} className="flip-rtl" />
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--ink-3)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} />
          {tx("Scheduled", "مجدول")}
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--ink-3)", marginInlineStart: 10 }} />
          {tx("Published", "منشور")}
        </span>
      </div>

      {(scheduledQ.error || publishedQ.error) && (
        <div style={{ fontSize: 12, color: "var(--bad)", marginBottom: 8 }}>
          {tx("Couldn't load some posts.", "تعذر تحميل بعض المنشورات.")}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {weeks[0].map((d) => (
          <div key={`h-${d.getDay()}`} className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", padding: "0 6px 4px" }}>
            {d.toLocaleDateString(t.lang === "ar" ? "ar" : undefined, { weekday: "short" })}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const key = localDayKey(d);
          const inMonth = d.getMonth() === month;
          const dayItems = byDay.get(key) ?? [];
          const isExpanded = expandedDay === key;
          const visible = isExpanded ? dayItems : dayItems.slice(0, 3);
          return (
            <div
              key={key}
              style={{
                minHeight: 96,
                minWidth: 0,
                border: "1px solid var(--line-soft)",
                borderRadius: 8,
                padding: 6,
                background: key === todayKey ? "var(--accent-soft)" : inMonth ? "var(--bg-1)" : "var(--bg-2)",
                opacity: inMonth ? 1 : 0.55,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>{d.getDate()}</span>
              {visible.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setSelected(it)}
                  title={it.content}
                  style={{
                    textAlign: "start",
                    fontSize: 11,
                    lineHeight: 1.3,
                    padding: "3px 6px",
                    borderRadius: 6,
                    border: "1px solid transparent",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    background: it.kind === "scheduled" ? "var(--accent-soft)" : "var(--bg-2)",
                    color: it.kind === "scheduled" ? "var(--accent)" : "var(--ink-2)",
                  }}
                >
                  {it.date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{" "}
                  {it.content || tx("(no text)", "(بدون نص)")}
                </button>
              ))}
              {dayItems.length > 3 && !isExpanded && (
                <button type="button" className="btn ghost sm" style={{ fontSize: 10, padding: "1px 6px", alignSelf: "start" }} onClick={() => setExpandedDay(key)}>
                  +{dayItems.length - 3} {tx("more", "المزيد")}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {selected && (
        <PostDetailModal
          item={selected}
          tx={tx}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setSelected(null);
            refetchAll();
          }}
        />
      )}
    </div>
  );
}

function PostDetailModal({
  item,
  tx,
  onClose,
  onChanged,
}: {
  item: CalItem;
  tx: (en: string, ar: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [newTime, setNewTime] = useState<Date | null>(null);
  const [armedCancel, setArmedCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rescheduleMut = useMutation<{ id: string; scheduledFor: string; timezone: string }, { ok: true }>(
    ({ id, scheduledFor, timezone }) => api.patch(`/social/scheduled/${id}`, { scheduledFor, timezone }),
  );
  const cancelMut = useMutation<{ id: string }, { ok: true }>(({ id }) => api.delete(`/social/scheduled/${id}`));

  const busy = rescheduleMut.loading || cancelMut.loading;

  return (
    <Modal onClose={busy ? () => {} : onClose} width={480} label="Post details" panelStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            padding: "2px 8px",
            borderRadius: 999,
            background: item.kind === "scheduled" ? "var(--accent-soft)" : "var(--bg-2)",
            color: item.kind === "scheduled" ? "var(--accent)" : "var(--ink-2)",
          }}
        >
          {item.kind === "scheduled" ? tx("Scheduled", "مجدول") : tx("Published", "منشور")}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {item.platforms.join(" · ")} — {item.date.toLocaleString()}
        </span>
      </div>

      {item.mediaUrl && (
        <img src={item.mediaUrl} alt="" style={{ maxHeight: 180, objectFit: "cover", borderRadius: 8 }} />
      )}

      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.5, maxHeight: 160, overflowY: "auto" }}>
        {item.content || tx("(no text)", "(بدون نص)")}
      </div>

      {item.kind === "published" && item.permalink && (
        <a href={item.permalink} target="_blank" rel="noreferrer" className="btn" style={{ alignSelf: "start" }}>
          {tx("View on platform", "عرض على المنصة")}
        </a>
      )}

      {item.kind === "scheduled" && (
        <>
          <div>
            <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)", textTransform: "uppercase", marginBottom: 6 }}>
              {tx("Reschedule to", "إعادة الجدولة إلى")}
            </div>
            <SchedulePicker value={newTime} onChange={setNewTime} tx={tx} />
          </div>
          {error && <div style={{ fontSize: 12, color: "var(--bad)" }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className={armedCancel ? "btn sm danger" : "btn ghost"}
              disabled={busy}
              onBlur={() => setArmedCancel(false)}
              onClick={() => {
                if (!armedCancel) {
                  setArmedCancel(true);
                  setError(null);
                  return;
                }
                setArmedCancel(false);
                void cancelMut
                  .mutate({ id: item.id })
                  .then(onChanged)
                  .catch(() => setError(tx("Couldn't cancel this post.", "تعذر إلغاء هذا المنشور.")));
              }}
            >
              {armedCancel ? tx("Confirm cancel", "تأكيد الإلغاء") : tx("Cancel post", "إلغاء المنشور")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!newTime || busy}
              onClick={() => {
                if (!newTime) return;
                setError(null);
                void rescheduleMut
                  .mutate({
                    id: item.id,
                    scheduledFor: newTime.toISOString(),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  })
                  .then(onChanged)
                  .catch(() => setError(tx("Couldn't reschedule this post.", "تعذرت إعادة جدولة المنشور.")));
              }}
            >
              {rescheduleMut.loading ? tx("Rescheduling…", "جارٍ إعادة الجدولة…") : tx("Reschedule", "إعادة جدولة")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
