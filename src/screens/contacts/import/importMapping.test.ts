import { describe, expect, it } from "vitest";
import { errorsToCsv, targetsFor, validateMapping } from "./importMapping";
import { messageText } from "./importMessages";
import type { CustomFieldDef } from "@/lib/types";

const def = (id: string, label: string, archivedAt: string | null = null): CustomFieldDef => ({
  id, key: id, label, labelAr: label + " ع", type: "text", options: null, order: 0, archivedAt,
});

describe("validateMapping", () => {
  it("requires name, firstName or phone", () => {
    expect(validateMapping({ A: "email", B: "tags" })).toEqual({ error: "imports.mapping_required" });
    expect(validateMapping({})).toEqual({ error: "imports.mapping_required" });
    expect(validateMapping({ A: "ignore" })).toEqual({ error: "imports.mapping_required" });
  });
  it("accepts any one identity target", () => {
    expect(validateMapping({ A: "name" })).toEqual({ ok: true });
    expect(validateMapping({ A: "firstName" })).toEqual({ ok: true });
    expect(validateMapping({ A: "phone" })).toEqual({ ok: true });
  });
  it("rejects a target mapped twice, except tags and ignore", () => {
    expect(validateMapping({ A: "phone", B: "phone" })).toEqual({ error: "imports.mapping_duplicate" });
    expect(validateMapping({ A: "name", B: "custom:x", C: "custom:x" })).toEqual({ error: "imports.mapping_duplicate" });
    expect(validateMapping({ A: "name", B: "tags", C: "tags", D: "ignore", E: "ignore" })).toEqual({ ok: true });
  });
});

describe("targetsFor", () => {
  it("lists built-in targets then non-archived custom fields", () => {
    const t = targetsFor([def("a", "Plan"), def("b", "Old", "2020-01-01")]);
    const values = t.map((x) => x.value);
    expect(values.slice(0, 3)).toEqual(["ignore", "firstName", "lastName"]);
    expect(values).toContain("custom:a");
    expect(values).not.toContain("custom:b");
    expect(t.find((x) => x.value === "custom:a")).toMatchObject({ en: "Plan", ar: "Plan ع" });
    expect(t.every((x) => x.en && x.ar)).toBe(true);
  });
});

describe("messageText", () => {
  const ar = (_a: string, b: string) => b;
  const en = (a: string) => a;
  const keys = [
    "imports.file_empty", "imports.file_too_large", "imports.unsupported_type", "imports.file_invalid",
    "imports.file_missing", "imports.invalid_kind", "imports.invalid_state", "imports.not_previewed",
    "imports.options_invalid", "imports.group_required", "imports.group_invalid", "imports.mapping_invalid",
    "imports.mapping_duplicate", "imports.mapping_required", "imports.custom_field_invalid",
    "imports.owner_invalid", "imports.pipeline_invalid", "imports.pipeline_too_large", "imports.forbidden",
    "imports.err.no_identity", "imports.err.bad_email", "imports.err.bad_phone",
    "imports.err.bad_custom_value", "imports.err.owner_not_found",
  ];
  it("has English and Arabic text for every backend key", () => {
    for (const k of keys) {
      expect(messageText(k, en)).not.toBe(k);
      expect(messageText(k, en).length).toBeGreaterThan(3);
      expect(messageText(k, ar)).toMatch(/[؀-ۿ]/);
    }
  });
  it("falls back to a generic message for unknown keys", () => {
    expect(messageText("nope", en)).toBe("Something went wrong with the import.");
    expect(messageText(undefined, ar)).toMatch(/[؀-ۿ]/);
  });
});

describe("errorsToCsv", () => {
  it("writes a BOM, header and quoted, formula-safe cells", () => {
    const csv = errorsToCsv([{ row: 3, column: "Email", reason: 'bad, "x"' }, { row: 4, column: null, reason: "=SUM(A1)" }], ["Row", "Column", "Reason"]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Row,Column,Reason");
    expect(lines[1]).toBe('3,Email,"bad, ""x"""');
    expect(lines[2]).toBe("4,,'=SUM(A1)");
  });
});
