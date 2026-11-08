import { describe, expect, it } from "vitest";
import { decodeJson, encodeJson, getHashParam, setHashParam } from "./hashState";

describe("hashState", () => {
  it("round-trips unicode json", () => {
    const v = { tags: ["عميل مهم"], n: 2 };
    expect(decodeJson(encodeJson(v))).toEqual(v);
  });
  it("returns null on garbage or empty", () => {
    expect(decodeJson("%%%")).toBeNull();
    expect(decodeJson(btoa("nope"))).toBeNull();
    expect(decodeJson(null)).toBeNull();
    expect(decodeJson("")).toBeNull();
  });
  it("reads a param", () => {
    expect(getHashParam("#/contacts?cf=abc&x=1", "cf")).toBe("abc");
    expect(getHashParam("#/contacts", "cf")).toBeNull();
  });
  it("sets and removes params while keeping others", () => {
    expect(setHashParam("#/contacts", "cf", "abc")).toBe("#/contacts?cf=abc");
    expect(setHashParam("#/contacts?x=1", "cf", "abc")).toBe("#/contacts?x=1&cf=abc");
    expect(setHashParam("#/contacts?cf=abc&x=1", "cf", null)).toBe("#/contacts?x=1");
    expect(setHashParam("#/contacts?cf=abc", "cf", null)).toBe("#/contacts");
  });
});
