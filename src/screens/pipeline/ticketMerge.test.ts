import { describe, expect, it } from "vitest";
import { mergeTicket } from "./ticketMerge";

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
