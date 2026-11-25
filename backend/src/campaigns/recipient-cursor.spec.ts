import { HttpException } from "@nestjs/common";
import { decodeCursor, encodeCursor } from "./recipient-cursor";

function keyOf(fn: () => unknown): { status: number; key: unknown } {
  try {
    fn();
  } catch (e) {
    const he = e as HttpException;
    return { status: he.getStatus(), key: (he.getResponse() as { message?: unknown }).message };
  }
  throw new Error("did not throw");
}

describe("recipient cursor", () => {
  it("round-trips {v, id, s} as base64url", () => {
    const c = encodeCursor("ckabc123", "read");
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(c, "base64url").toString("utf8"))).toEqual({ v: 1, id: "ckabc123", s: "read" });
    expect(decodeCursor(c, "read")).toBe("ckabc123");
    const all = encodeCursor("x", null);
    expect(decodeCursor(all, undefined)).toBe("x");
    expect(decodeCursor(all, null)).toBe("x");
  });

  it("absent cursor means the first page", () => {
    expect(decodeCursor(undefined, "read")).toBeNull();
    expect(decodeCursor("", null)).toBeNull();
  });

  it.each([
    ["not base64 json", "%%%"],
    ["json but not an object", Buffer.from("123").toString("base64url")],
    ["wrong version", Buffer.from(JSON.stringify({ v: 2, id: "a", s: null })).toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ v: 1, s: null })).toString("base64url")],
    ["empty id", Buffer.from(JSON.stringify({ v: 1, id: "", s: null })).toString("base64url")],
    ["numeric id", Buffer.from(JSON.stringify({ v: 1, id: 5, s: null })).toString("base64url")],
  ])("rejects a malformed cursor (%s) with 400 campaigns.invalid_cursor", (_n, c) => {
    expect(keyOf(() => decodeCursor(c, null))).toEqual({ status: 400, key: "campaigns.invalid_cursor" });
  });

  it("rejects a cursor minted for another status filter", () => {
    const read = encodeCursor("a", "read");
    expect(keyOf(() => decodeCursor(read, "failed"))).toEqual({ status: 400, key: "campaigns.invalid_cursor" });
    expect(keyOf(() => decodeCursor(read, undefined))).toEqual({ status: 400, key: "campaigns.invalid_cursor" });
    const all = encodeCursor("a", null);
    expect(keyOf(() => decodeCursor(all, "read"))).toEqual({ status: 400, key: "campaigns.invalid_cursor" });
  });
});
