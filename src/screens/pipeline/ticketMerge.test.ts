import { describe, expect, it } from "vitest";
import { mergeCachedTicket, mergeTicket } from "./ticketMerge";
import realtimeSrc from "./hooks/useTicketRealtime.ts?raw";
import mutationsSrc from "./hooks/useTicketMutations.ts?raw";
import supportSrc from "./hooks/useTicketSupport.ts?raw";

describe("mergeTicket", () => {
  it("keeps read-time fields a raw row does not carry", () => {
    const prev = { id: "t1", priority: "normal", channel: { kind: "whatsapp" }, attachmentCount: 3, activities: [1] };
    const next = { id: "t1", priority: "urgent" } as typeof prev;
    expect(mergeTicket(prev, next)).toEqual({ ...prev, priority: "urgent" });
  });
  it("takes explicit nulls (a cleared category) and ignores another ticket", () => {
    const prev = { id: "t1", category: "complaint" as string | null };
    expect(mergeTicket(prev, { id: "t1", category: null })).toEqual({ id: "t1", category: null });
    expect(mergeTicket({ id: "t2", category: "x" }, { id: "t1", category: null })).toEqual({ id: "t1", category: null });
    expect(mergeTicket(undefined, { id: "t1" })).toEqual({ id: "t1" });
  });
});

describe("mergeCachedTicket (final review M1)", () => {
  it("never seeds an empty detail cache from a raw row; merges into an existing one", () => {
    expect(mergeCachedTicket(undefined, { id: "t1", priority: "urgent" })).toBeUndefined();
    const prev = { id: "t1", priority: "normal", activities: [1], pipeline: { kind: "support" } };
    expect(mergeCachedTicket(prev, { id: "t1", priority: "urgent" } as typeof prev)).toEqual({ ...prev, priority: "urgent" });
  });

  it("the realtime, update and resolve detail-cache writes use the guard", () => {
    for (const [name, src] of [
      ["useTicketRealtime", realtimeSrc],
      ["useTicketMutations", mutationsSrc],
      ["useTicketSupport", supportSrc],
    ] as const) {
      const detailWrites = src.match(/setQueryData<[^>]+>\(qk\.ticket\([^)]*\),[^;]*;/g) ?? [];
      expect({ name, n: detailWrites.length > 0 }).toEqual({ name, n: true });
      for (const w of detailWrites) expect({ name, w, guarded: w.includes("mergeCachedTicket") || /prev \? /.test(w) }).toEqual({ name, w, guarded: true });
    }
  });
});
