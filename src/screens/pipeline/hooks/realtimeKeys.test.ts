import { describe, expect, it } from "vitest";
import { isRefetchOnRealtimeKey, isUnfilteredStageKey } from "./realtimeKeys";

describe("realtime cache key selection", () => {
  const plain = ["tickets", "stage", "p1", "s1", {}];
  const emptyQs = ["tickets", "stage", "p1", "s1", { qs: "" }];
  const filtered = ["tickets", "stage", "p1", "s1", { qs: "ownerId=u1" }];
  const table = ["tickets", "table", "p1", "view=table&sort=createdAt"];

  it("patches only unfiltered stage caches of the pipeline", () => {
    expect(isUnfilteredStageKey(plain, "p1")).toBe(true);
    expect(isUnfilteredStageKey(emptyQs, "p1")).toBe(true);
    expect(isUnfilteredStageKey(filtered, "p1")).toBe(false);
    expect(isUnfilteredStageKey(plain, "p2")).toBe(false);
    expect(isUnfilteredStageKey(table, "p1")).toBe(false);
  });

  it("refetches filtered stage caches and the table, never unfiltered ones or other pipelines", () => {
    expect(isRefetchOnRealtimeKey(filtered, "p1")).toBe(true);
    expect(isRefetchOnRealtimeKey(table, "p1")).toBe(true);
    expect(isRefetchOnRealtimeKey(plain, "p1")).toBe(false);
    expect(isRefetchOnRealtimeKey(filtered, "p2")).toBe(false);
    expect(isRefetchOnRealtimeKey(table, "p2")).toBe(false);
  });
});
