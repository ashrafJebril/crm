import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Conversation } from "../../lib/types";

// prefetchFetch reads through the api client: count the GETs instead.
const get = vi.fn();
vi.mock("@/api/client", () => ({ api: { get: (...a: unknown[]) => get(...a) }, ApiError: class extends Error {} }));

import { fetchQueryKey, prefetchFetch } from "@/api/useFetch";
import { DETAIL_STALE_MS, clearUnread, markReadAndPatch, threadFor } from "./inboxCache";

const mk = (o: Partial<Conversation>): Conversation =>
  ({ id: "c1", contactId: "k1", unread: 0, pinned: false, lastAt: "", lastFrom: "them", preview: "hi", channel: "whatsapp", status: "human", intent: "", confidence: 0, ...o }) as Conversation;
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => get.mockReset());

describe("opening a conversation", () => {
  it("does not refetch /conversations: the read is a POST and the cached list is patched in place", async () => {
    const qc = new QueryClient();
    const listKey = fetchQueryKey("/conversations");
    const listFetch = vi.fn(async () => [mk({ id: "a", unread: 3 }), mk({ id: "b", unread: 1 })]);
    await qc.fetchQuery({ queryKey: listKey, queryFn: listFetch });
    const post = vi.fn(async () => ({}));
    await markReadAndPatch("a", post, (fn) => qc.setQueryData<Conversation[] | null>(listKey, (prev) => fn(prev ?? null)));
    expect(post).toHaveBeenCalledWith("/conversations/a/read");
    expect(listFetch).toHaveBeenCalledTimes(1); // only the first load
    // Unread is cleared in the cache; the other row is untouched.
    const list = qc.getQueryData<Conversation[]>(listKey)!;
    expect(list.map((c) => [c.id, c.unread])).toEqual([["a", 0], ["b", 1]]);
  });

  it("clearUnread keeps the same array when nothing changes", () => {
    const l = [mk({ id: "a", unread: 0 })];
    expect(clearUnread(l, "a")).toBe(l);
    expect(clearUnread(l, "zz")).toBe(l);
    expect(clearUnread(null, "a")).toBeNull();
  });

  it("the thread shows at once from the list row; a previous conversation's detail never shows under another id", () => {
    const row = mk({ id: "b", preview: "row preview" });
    const prevDetail = { id: "a", messages: [{ body: "old" }] };
    expect(threadFor("b", prevDetail, row)).toMatchObject({ id: "b", preview: "row preview", messages: [], placeholder: true });
    const ownDetail = { id: "b", messages: [{ body: "loaded" }] };
    expect(threadFor("b", ownDetail, row)).toBe(ownDetail);
    expect(threadFor("b", null, undefined)).toBeUndefined();
    expect(threadFor(null, ownDetail, row)).toBeUndefined();
  });

  it("reuses a cached detail: hovering prefetches it once, and opening or going back within the fresh window does not fetch again", async () => {
    const qc = new QueryClient();
    get.mockResolvedValue({ id: "b", messages: [] });
    await prefetchFetch(qc, "/conversations/b", { key: "b:0", staleMs: DETAIL_STALE_MS });
    await prefetchFetch(qc, "/conversations/b", { key: "b:0", staleMs: DETAIL_STALE_MS });
    expect(get).toHaveBeenCalledTimes(1);
    // The open reads the same entry (useFetch's key format) and finds it fresh.
    const obs = new QueryObserver(qc, { queryKey: fetchQueryKey("/conversations/b", "b:0"), queryFn: () => get("/conversations/b"), staleTime: DETAIL_STALE_MS });
    const unsub = obs.subscribe(() => undefined);
    expect(obs.getCurrentResult().data).toEqual({ id: "b", messages: [] });
    expect(get).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("the list never cancels an identical fetch in flight (dedupeRefetch)", () => {
  it("refetch with cancelRefetch: false reuses the running request; the default cancels and restarts it", async () => {
    // React Query cancels an in-flight fetch only when data is already cached: the inbox list case.
    for (const [cancelRefetch, calls] of [[false, 2], [true, 3]] as const) {
      const qc = new QueryClient();
      let d = deferred<string[]>();
      const fetcher = vi.fn(() => d.promise);
      const obs = new QueryObserver(qc, { queryKey: ["/conversations", String(cancelRefetch)], queryFn: fetcher });
      const unsub = obs.subscribe(() => undefined);
      d.resolve(["a"]);
      await obs.refetch({ cancelRefetch: false }); // the first load (1 call)
      d = deferred<string[]>();
      void obs.refetch({ cancelRefetch: false }).catch(() => undefined); // a background refresh in flight (2)
      const again = obs.refetch({ cancelRefetch }); // a second, identical one while it runs
      d.resolve(["a", "b"]);
      await again;
      expect(fetcher).toHaveBeenCalledTimes(calls);
      unsub();
    }
  });
});

import { HOVER_PREFETCH_MS, LOCAL_READ_MS, applyLocalReads, createRowPrefetcher, detailPath, invalidateConversationDetail, isDetailStale } from "./inboxCache";

describe("review fixes: stale details, hover intent, the read race", () => {
  it("I1: B is cached, a message arrives for B while A is open, then opening B fetches again", async () => {
    const qc = new QueryClient();
    get.mockResolvedValue({ id: "b", messages: [{ createdAt: "2026-11-22T09:00:00Z" }] });
    await prefetchFetch(qc, detailPath("b"), { key: "b:0", staleMs: DETAIL_STALE_MS });
    expect(get).toHaveBeenCalledTimes(1);
    // inbox.activity for B (A is the open one): every cached B detail is invalidated.
    await invalidateConversationDetail(qc, "b");
    get.mockResolvedValue({ id: "b", messages: [{ createdAt: "2026-11-22T09:00:00Z" }, { createdAt: "2026-11-22T09:05:00Z" }] });
    const obs = new QueryObserver(qc, { queryKey: fetchQueryKey(detailPath("b"), "b:0"), queryFn: () => get(detailPath("b")), staleTime: DETAIL_STALE_MS });
    const unsub = obs.subscribe(() => undefined);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((obs.getCurrentResult().data as { messages: unknown[] }).messages).toHaveLength(2));
    unsub();
    // The list itself is not touched by a detail invalidation.
    expect(qc.getQueryState(fetchQueryKey("/conversations"))).toBeUndefined();
  });

  it("I1: a cached detail older than the row's lastMessageAt is stale", () => {
    const detail = { messages: [{ createdAt: "2026-11-22T09:00:00Z" }, { createdAt: "2026-11-22T09:05:00Z" }] };
    expect(isDetailStale(detail, { lastMessageAt: "2026-11-22T09:06:00Z" })).toBe(true);
    expect(isDetailStale(detail, { lastMessageAt: "2026-11-22T09:05:00Z" })).toBe(false);
    expect(isDetailStale(detail, { lastMessageAt: null })).toBe(false);
    expect(isDetailStale(null, { lastMessageAt: "2026-11-22T09:06:00Z" })).toBe(false);
    expect(isDetailStale({ messages: [] }, { lastMessageAt: "2026-11-22T09:06:00Z" })).toBe(true);
  });

  it("M1: sweeping across rows fires no prefetches; a 150 ms hover does; focus does at once", () => {
    vi.useFakeTimers();
    try {
      const prefetch = vi.fn();
      const p = createRowPrefetcher(prefetch);
      for (const id of ["a", "b", "c", "d"]) {
        p.enter(id);
        vi.advanceTimersByTime(40);
        p.leave();
      }
      vi.advanceTimersByTime(1000);
      expect(prefetch).not.toHaveBeenCalled();
      p.enter("e");
      vi.advanceTimersByTime(HOVER_PREFETCH_MS);
      expect(prefetch).toHaveBeenCalledWith("e");
      p.focus("f");
      expect(prefetch).toHaveBeenLastCalledWith("f");
      expect(prefetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("M2: a list response that started before the read does not bring the badge back", () => {
    const T = Date.parse("2026-11-22T10:00:00Z");
    const reads = new Map([["a", T]]);
    // The stale response: still unread, customer's last message before the read.
    const stale = [mk({ id: "a", unread: 3, lastInboundAt: "2026-11-22T09:59:00Z" }), mk({ id: "b", unread: 2 })];
    expect(applyLocalReads(stale, reads, T + 1000).map((c) => c.unread)).toEqual([0, 2]);
    // The customer wrote after the read: the badge is real.
    const fresh = [mk({ id: "a", unread: 1, lastInboundAt: "2026-11-22T10:00:05Z" })];
    expect(applyLocalReads(fresh, reads, T + 6000)[0]!.unread).toBe(1);
    // After 60 s the mark is dropped.
    expect(applyLocalReads(stale, reads, T + LOCAL_READ_MS + 1)[0]!.unread).toBe(3);
    expect(reads.size).toBe(0);
  });
});
