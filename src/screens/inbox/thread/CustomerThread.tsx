import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { Lang, Message } from "@/lib/types";
import { SegmentSeam } from "./SegmentSeam";
import { ThreadEvent } from "./ThreadEvent";
import { mergePage, type ThreadItem, type ThreadPage } from "./threadModel";

const PAGE_SIZE = 50;

/** "All conversations" view: every DB conversation of one customer stitched into
 *  one thread (newest at the bottom), with seams between conversations and
 *  inline events. Older history loads lazily as the user scrolls to the top. */
export function CustomerThread({
  contactId,
  lang,
  tx,
  scrollerRef,
  refreshToken,
  renderMessage,
  dayLabel,
  onChanged,
}: {
  contactId: string;
  lang: Lang;
  tx: Tx;
  /** The scrolling container this view renders inside. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Changes when the active conversation received something; refetches the pages. */
  refreshToken: string;
  renderMessage: (m: Message) => ReactNode;
  dayLabel: (iso: string) => string;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();
  const q = useInfiniteQuery<ThreadPage, Error, { pages: ThreadPage[] }, unknown[], string | null>({
    queryKey: ["thread", contactId],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.get<ThreadPage>(
        `/contacts/${contactId}/thread?limit=${PAGE_SIZE}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (last) => last.nextBefore ?? null,
  });

  // Realtime / polling on the active conversation: refetch what is loaded.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void qc.invalidateQueries({ queryKey: ["thread", contactId] });
  }, [refreshToken, contactId, qc]);

  // Newest first from the server; flip for display.
  const items = useMemo<ThreadItem[]>(() => {
    const merged = (q.data?.pages ?? []).reduce<ThreadItem[]>((acc, p) => mergePage(acc, p.items), []);
    return merged.slice().reverse();
  }, [q.data]);

  // Land on the newest item once; keep the viewport anchored when older pages prepend.
  const landed = useRef<string | null>(null);
  const prevHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (items.length > 0 && landed.current !== contactId) {
      landed.current = contactId;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (prevHeight.current !== null) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    }
  }, [items, contactId, scrollerRef]);

  const topRef = useRef<HTMLDivElement | null>(null);
  const loadOlder = () => {
    if (!q.hasNextPage || q.isFetchingNextPage) return;
    prevHeight.current = scrollerRef.current?.scrollHeight ?? null;
    void q.fetchNextPage();
  };
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  useEffect(() => {
    const el = topRef.current;
    const root = scrollerRef.current;
    if (!el || !root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && landed.current === contactId) loadOlderRef.current();
    }, { root });
    io.observe(el);
    return () => io.disconnect();
  }, [scrollerRef, contactId, items.length]);

  if (q.isPending) {
    return (
      <div className="muted" style={{ textAlign: "center", fontSize: 12, padding: "24px 0" }}>
        {tx("Loading the full thread…", "جارٍ تحميل المحادثة الكاملة…")}
      </div>
    );
  }
  if (q.isError && items.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "24px 0", fontSize: 12 }}>
        <div role="alert" style={{ color: "var(--bad)" }}>{q.error.message}</div>
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => void q.refetch()}>
          {tx("Retry", "إعادة")}
        </button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="muted" style={{ textAlign: "center", fontSize: 12, padding: "24px 0" }}>
        {tx("No messages for this customer yet.", "لا توجد رسائل لهذا العميل بعد.")}
      </div>
    );
  }

  let prevDay = "";
  return (
    <>
      <div ref={topRef} style={{ textAlign: "center", minHeight: 1 }}>
        {q.hasNextPage ? (
          <button type="button" className="btn ghost sm" onClick={loadOlder} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage
              ? tx("Loading earlier history…", "جارٍ تحميل السجل الأقدم…")
              : tx("Load earlier history", "تحميل السجل الأقدم")}
          </button>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            {tx("Start of this customer's history", "بداية سجل هذا العميل")}
          </span>
        )}
      </div>
      {q.isError && (
        <div role="alert" style={{ textAlign: "center", color: "var(--bad)", fontSize: 11.5 }}>{q.error.message}</div>
      )}
      {items.map((it) => {
        const day = it.type === "seam" ? "" : dayLabel(it.at);
        const showDay = !!day && day !== prevDay;
        if (day) prevDay = day;
        return (
          <Fragment key={`${it.type}:${it.id}`}>
            {showDay && (
              <div className="day-divider">
                <span>{day}</span>
              </div>
            )}
            {it.type === "seam" ? (
              <SegmentSeam channel={it.channel} startedAt={it.startedAt} lang={lang} />
            ) : it.type === "event" ? (
              <ThreadEvent event={it} tx={tx} lang={lang} onUndone={onChanged} />
            ) : (
              renderMessage({ ...it.message, createdAt: it.message.createdAt ?? it.at })
            )}
          </Fragment>
        );
      })}
    </>
  );
}
