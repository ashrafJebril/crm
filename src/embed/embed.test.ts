import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedParentOrigins, isAllowedParent, parseInbound } from "./embed";

const parent = {};
const A = ["https://a.com"];

beforeEach(() => {
  vi.stubGlobal("window", { parent, location: { origin: "https://crm.example" } });
});
afterEach(() => vi.unstubAllGlobals());

const ev = (o: Partial<{ origin: string; source: unknown; data: unknown }>) =>
  ({ origin: "https://a.com", source: parent, data: {}, ...o }) as unknown as MessageEvent;

describe("allowedParentOrigins", () => {
  it("splits, trims, drops empties", () => {
    expect(allowedParentOrigins("https://a.com, http://localhost:5173 ,")).toEqual([
      "https://a.com",
      "http://localhost:5173",
    ]);
  });
  it("empty/undefined -> []", () => {
    expect(allowedParentOrigins("")).toEqual([]);
    expect(allowedParentOrigins(undefined)).toEqual([]);
  });
});

describe("isAllowedParent", () => {
  it("exact match only", () => {
    expect(isAllowedParent("https://a.com", A)).toBe(true);
    expect(isAllowedParent("https://evil.com", A)).toBe(false);
    expect(isAllowedParent("https://a.com.evil.com", A)).toBe(false);
  });
});

describe("parseInbound", () => {
  it("accepts navigate from allowed parent", () => {
    expect(parseInbound(ev({ data: { type: "kewy:navigate", route: "inbox" } }), A)).toEqual({
      type: "kewy:navigate",
      route: "inbox",
    });
  });
  it("rejects disallowed origin", () => {
    expect(parseInbound(ev({ origin: "https://evil.com", data: { type: "kewy:navigate", route: "inbox" } }), A)).toBeNull();
  });
  it("rejects wrong source", () => {
    expect(parseInbound(ev({ source: {}, data: { type: "kewy:navigate", route: "inbox" } }), A)).toBeNull();
  });
  it("rejects unknown type and non-string route", () => {
    expect(parseInbound(ev({ data: { type: "x", route: "inbox" } }), A)).toBeNull();
    expect(parseInbound(ev({ data: { type: "kewy:navigate", route: 3 } }), A)).toBeNull();
    expect(parseInbound(ev({ data: null }), A)).toBeNull();
  });
  it("connected only from same origin", () => {
    const data = { type: "kewy:connected", provider: "instagram" };
    expect(parseInbound(ev({ origin: "https://crm.example", source: {}, data }), A)).toEqual(data);
    expect(parseInbound(ev({ origin: "https://a.com", data }), A)).toBeNull();
  });
});
