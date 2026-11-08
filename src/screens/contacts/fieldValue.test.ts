import { describe, expect, it } from "vitest";
import { formatFieldValue, parseFieldInput } from "./fieldValue";

describe("parseFieldInput", () => {
  it("text: trims, empty clears, caps at 2000", () => {
    expect(parseFieldInput("text", "  hello ")).toEqual({ ok: true, value: "hello" });
    expect(parseFieldInput("text", "   ")).toEqual({ ok: true, value: null });
    expect(parseFieldInput("text", "x".repeat(2000)).ok).toBe(true);
    expect(parseFieldInput("text", "x".repeat(2001)).ok).toBe(false);
  });

  it("number: parses, normalizes Arabic-Indic and Persian digits", () => {
    expect(parseFieldInput("number", "42.5")).toEqual({ ok: true, value: 42.5 });
    expect(parseFieldInput("number", "١٢٣")).toEqual({ ok: true, value: 123 });
    expect(parseFieldInput("number", "۴۵٫۵")).toEqual({ ok: true, value: 45.5 });
    expect(parseFieldInput("number", "-7")).toEqual({ ok: true, value: -7 });
    expect(parseFieldInput("number", "")).toEqual({ ok: true, value: null });
  });

  it("number: rejects non-finite or garbage", () => {
    expect(parseFieldInput("number", "abc").ok).toBe(false);
    expect(parseFieldInput("number", "1e999").ok).toBe(false);
    expect(parseFieldInput("number", "Infinity").ok).toBe(false);
    expect(parseFieldInput("number", "1.2.3").ok).toBe(false);
  });

  it("date: accepts real YYYY-MM-DD, rejects impossible dates", () => {
    expect(parseFieldInput("date", "2026-02-28")).toEqual({ ok: true, value: "2026-02-28" });
    expect(parseFieldInput("date", "2024-02-29").ok).toBe(true);
    expect(parseFieldInput("date", "2026-02-30").ok).toBe(false);
    expect(parseFieldInput("date", "2026-13-01").ok).toBe(false);
    expect(parseFieldInput("date", "28/02/2026").ok).toBe(false);
    expect(parseFieldInput("date", "")).toEqual({ ok: true, value: null });
  });

  it("date: normalizes Arabic-Indic digits", () => {
    expect(parseFieldInput("date", "٢٠٢٦-٠٢-٢٨")).toEqual({ ok: true, value: "2026-02-28" });
  });

  it("select: must be one of options", () => {
    expect(parseFieldInput("select", "A", ["A", "B"])).toEqual({ ok: true, value: "A" });
    expect(parseFieldInput("select", "C", ["A", "B"]).ok).toBe(false);
    expect(parseFieldInput("select", "", ["A", "B"])).toEqual({ ok: true, value: null });
  });

  it("boolean: strict true/false", () => {
    expect(parseFieldInput("boolean", true)).toEqual({ ok: true, value: true });
    expect(parseFieldInput("boolean", false)).toEqual({ ok: true, value: false });
    expect(parseFieldInput("boolean", "yes").ok).toBe(false);
  });
});

describe("formatFieldValue", () => {
  it("renders empty as a dash", () => {
    expect(formatFieldValue("text", null, "en")).toBe("—");
    expect(formatFieldValue("number", undefined, "en")).toBe("—");
  });
  it("text and select pass through", () => {
    expect(formatFieldValue("text", "hi", "en")).toBe("hi");
    expect(formatFieldValue("select", "A", "ar")).toBe("A");
  });
  it("boolean is localized", () => {
    expect(formatFieldValue("boolean", true, "en")).toBe("Yes");
    expect(formatFieldValue("boolean", false, "en")).toBe("No");
    expect(formatFieldValue("boolean", true, "ar")).toBe("نعم");
    expect(formatFieldValue("boolean", false, "ar")).toBe("لا");
  });
  it("number is locale-formatted", () => {
    expect(formatFieldValue("number", 1234.5, "en")).toBe("1,234.5");
  });
  it("date stays ISO", () => {
    expect(formatFieldValue("date", "2026-02-28", "en")).toBe("2026-02-28");
  });
});
