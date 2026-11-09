import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useTweaks } from "@/tweaks/context";
import { makeTx, type Tx } from "@/lib/tx";
import { openRecord } from "@/lib/openRecord";
import { formatDue, type ActivityKind } from "@/screens/followups/followupsLogic";
import { kindGlyph, kindLabel, useWorkspaceTz } from "./activityApi";

type TimelineType = "activity" | "note" | "ticket_activity" | "message";
interface TimelineItem {
  type: TimelineType;
  at: string;
  id: string;
  data: Record<string, unknown>;
}
interface TimelinePage {
  items: TimelineItem[];
  nextBefore?: string | null;
}

const ICON: Record<TimelineType, string> = { activity: "↻", note: "✎", ticket_activity: "▤", message: "✉" };

const s = (v: unknown): string => (typeof v === "string" ? v : "");

function ticketActivityText(tx: Tx, d: Record<string, unknown>): string {
  switch (s(d.kind)) {
    case "created": return tx("Ticket created", "تم إنشاء التذكرة");
    case "stage_changed": return tx(`Stage: ${s(d.fromStage)} → ${s(d.toStage)}`, `المرحلة: ${s(d.fromStage)} ← ${s(d.toStage)}`);
    case "owner_changed": return tx("Ticket owner changed", "تم تغيير مالك التذكرة");
    case "value_changed": return tx("Ticket value changed", "تم تغيير قيمة التذكرة");
    case "won": return tx("Ticket won", "تم ربح التذكرة");
    case "lost": return tx("Ticket lost", "تم خسارة التذكرة");
    default: return s(d.note) || tx("Ticket activity", "نشاط التذكرة");
  }
}

/** Unified contact timeline with infinite scroll on `nextBefore`. */
export function Timeline({ contactId }: { contactId: string }) {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const tz = useWorkspaceTz();
  const q = useInfiniteQuery<TimelinePage, Error, { pages: TimelinePage[] }, unknown[], string | null>({
    queryKey: ["contact-timeline", contactId],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.get<TimelinePage>(
        `/contacts/${contactId}/timeline?limit=30${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextBefore || null,
  });

  const sentinel = useRef<HTMLDivElement | null>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const now = new Date();
  const when = (iso: string) => formatDue(iso, now, tz, t.lang);

  if (q.isPending) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</div>;
  if (q.isError) return <div style={{ fontSize: 12, color: "var(--bad)" }}>{q.error.message}</div>;
  if (items.length === 0) return <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{tx("Nothing on the timeline yet.", "لا شيء في الخط الزمني بعد.")}</div>;

  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((it) => {
        const d = it.data;
        let heading = "";
        let body = "";
        let link: { label: string; open: () => void } | null = null;
        let icon = ICON[it.type];
        if (it.type === "activity") {
          const kind = s(d.kind) as ActivityKind;
          icon = kindGlyph[kind] ?? icon;
          heading = `${kindLabel(tx, kind)}: ${s(d.title)}`;
          body = [s(d.outcome), s(d.notes)].filter(Boolean).join(" · ");
          if (d.dueAt && !d.doneAt) body = `${tx("Due", "الموعد")} ${when(s(d.dueAt))}${body ? " · " + body : ""}`;
          else if (d.doneAt) body = `${tx("Done", "تم")} ${when(s(d.doneAt))}${body ? " · " + body : ""}`;
        } else if (it.type === "note") {
          heading = tx("Note", "ملاحظة");
          body = s(d.body);
        } else if (it.type === "ticket_activity") {
          heading = ticketActivityText(tx, d);
          body = s(d.kind) === "note" ? "" : s(d.note);
        } else {
          const from = s(d.from);
          const who = from === "them" ? tx("Customer", "العميل") : from === "ai" ? tx("AI", "الذكاء الاصطناعي") : tx("Team", "الفريق");
          heading = `${tx("Message", "رسالة")} · ${s(d.channel) || "—"} · ${who}`;
          body = s(d.body);
          const convId = s(d.conversationId);
          if (convId) link = { label: tx("Open conversation", "فتح المحادثة"), open: () => openRecord("conversation", convId) };
        }
        return (
          <li key={`${it.type}:${it.id}`} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span aria-hidden style={{ width: 22, height: 22, borderRadius: 999, background: "var(--bg-2)", display: "grid", placeItems: "center", fontSize: 12, flex: "0 0 auto" }}>{icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div dir="auto" style={{ fontSize: 12, fontWeight: 500 }}>{heading}</div>
              {body && (
                <div dir="auto" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {body.length > 400 ? `${body.slice(0, 400)}…` : body}
                </div>
              )}
              <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2, display: "flex", gap: 8 }}>
                <span className="mono">{when(it.at)}</span>
                {link && (
                  <button type="button" onClick={link.open} style={{ all: "unset", cursor: "pointer", color: "var(--accent)" }}>
                    {link.label}
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
      <div ref={sentinel} style={{ height: 1 }} />
      {isFetchingNextPage && <li style={{ fontSize: 11, color: "var(--ink-3)" }}>{tx("Loading…", "جارٍ التحميل…")}</li>}
    </ol>
  );
}
