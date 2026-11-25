import { describe, expect, it } from "vitest";
import { isStaleTicket } from "./stale";

const DAY = 86_400_000;
const now = Date.parse("2026-11-10T12:00:00Z");
const ago = (d: number) => new Date(now - d * DAY).toISOString();

describe("isStaleTicket", () => {
  it("is never stale when staleDays is unset", () => {
    expect(isStaleTicket(ago(100), null, now)).toBe(false);
    expect(isStaleTicket(ago(100), undefined, now)).toBe(false);
    expect(isStaleTicket(ago(100), 0, now)).toBe(false);
  });
  it("is stale only strictly beyond the threshold", () => {
    expect(isStaleTicket(ago(7), 7, now)).toBe(false);
    expect(isStaleTicket(ago(7.01), 7, now)).toBe(true);
    expect(isStaleTicket(ago(1), 7, now)).toBe(false);
  });
  it("ignores terminal stages and bad dates", () => {
    expect(isStaleTicket(ago(30), 7, now, true)).toBe(false);
    expect(isStaleTicket("nope", 7, now)).toBe(false);
  });
});
