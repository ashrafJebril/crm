import { describe, expect, it } from "vitest";
import type { CatalogImport, ProposalItem } from "@/lib/types";
import { canRun, editPatch, groupItems, pollMsFor, progressPct, reviewCounts, selectAllPatch, stepFor } from "./importReview";

const job = (over: Partial<CatalogImport> = {}): CatalogImport => ({
  id: "j1",
  source: "paste",
  kind: "auto",
  status: "review",
  extractedBy: "ai",
  fileName: null,
  sourceUrl: null,
  total: 0,
  processed: 0,
  created: 0,
  skipped: 0,
  failed: 0,
  errors: [],
  errorKey: null,
  createdAt: "2026-11-16T00:00:00Z",
  finishedAt: null,
  ...over,
});

const svc = (key: string, over: Partial<ProposalItem> = {}): ProposalItem => ({
  key,
  kind: "service",
  data: { name: "Cut", nameAr: "قص", durationMin: 60, durationDefaulted: true, price: null, currency: null },
  duplicateOf: null,
  selected: true,
  ...over,
});
const staff = (key: string, over: Partial<ProposalItem> = {}): ProposalItem => ({
  key,
  kind: "staff",
  data: { name: "Sara", nameAr: null, role: null, schedule: {}, services: [] },
  duplicateOf: null,
  selected: true,
  ...over,
});

describe("catalog import review model", () => {
  it("the wizard step follows the job status; polling only while the server works", () => {
    expect(stepFor(null)).toBe("source");
    expect(stepFor(job({ status: "extracting" }))).toBe("extracting");
    expect(stepFor(job({ status: "review" }))).toBe("review");
    expect(stepFor(job({ status: "running" }))).toBe("running");
    for (const status of ["done", "failed", "cancelled"] as const) expect(stepFor(job({ status }))).toBe("result");
    expect(pollMsFor(job({ status: "extracting" }))).toBe(2000);
    expect(pollMsFor(job({ status: "running" }))).toBe(1500);
    expect(pollMsFor(job({ status: "review" }))).toBeNull();
    expect(pollMsFor(null)).toBeNull();
  });

  it("progress", () => {
    expect(progressPct(job({ status: "running", total: 12, processed: 7 }))).toBe(58);
    expect(progressPct(job({ status: "running", total: 0 }))).toBe(0);
    expect(progressPct(job({ status: "done", total: 3, processed: 3 }))).toBe(100);
  });

  it("groups by kind and counts; duplicates and errors start unchecked and a selected error blocks the run", () => {
    const items = [
      svc("s1"),
      svc("s2", { duplicateOf: { id: "x", name: "Cut" }, selected: false }),
      svc("s3", { error: { field: "durationMin", reason: "out_of_range" }, selected: false }),
      staff("t1"),
    ];
    expect(groupItems(items).services.map((i) => i.key)).toEqual(["s1", "s2", "s3"]);
    expect(groupItems(items).staff.map((i) => i.key)).toEqual(["t1"]);
    expect(reviewCounts(items)).toEqual({ total: 4, selected: 2, duplicates: 1, errors: 1, blocking: 0 });
    expect(canRun(items)).toBe(true);
    expect(canRun(items.map((i) => (i.key === "s3" ? { ...i, selected: true } : i)))).toBe(false);
    expect(canRun(items.map((i) => ({ ...i, selected: false })))).toBe(false);
  });

  it("select all leaves rows with errors unchecked; select none unchecks the selected", () => {
    const items = [svc("s1", { selected: false }), svc("s2", { selected: false, error: { field: "price", reason: "invalid" } }), svc("s3")];
    expect(selectAllPatch(items, true)).toEqual([{ key: "s1", selected: true }]);
    expect(selectAllPatch(items, false)).toEqual([{ key: "s3", selected: false }]);
  });

  it("edits mirror the backend's item_invalid fields", () => {
    const s = svc("s1");
    expect(editPatch(s, "durationMin", "45")).toEqual({ ok: true, patch: { key: "s1", data: { durationMin: 45 } } });
    for (const v of ["4", "1441", "4.5", "abc", ""]) expect(editPatch(s, "durationMin", v)).toEqual({ ok: false, field: "durationMin" });
    expect(editPatch(s, "price", "120.5")).toEqual({ ok: true, patch: { key: "s1", data: { price: "120.5" } } });
    expect(editPatch(s, "price", "")).toEqual({ ok: true, patch: { key: "s1", data: { price: null } } });
    for (const v of ["-5", "1.234", "12,5"]) expect(editPatch(s, "price", v)).toEqual({ ok: false, field: "price" });
    expect(editPatch(s, "currency", "aed")).toEqual({ ok: true, patch: { key: "s1", data: { currency: "AED" } } });
    expect(editPatch(s, "currency", "riyal")).toEqual({ ok: false, field: "currency" });
    expect(editPatch(s, "name", "  ")).toEqual({ ok: false, field: "name" });
    expect(editPatch(s, "schedule", {})).toEqual({ ok: false, field: "schedule" }); // not a service field
    const t = staff("t1");
    expect(editPatch(t, "schedule", { mon: [{ from: "18:00", to: "09:00" }] })).toEqual({ ok: false, field: "schedule" });
    expect(editPatch(t, "schedule", { mon: [{ from: "09:00", to: "17:00" }] })).toEqual({
      ok: true,
      patch: { key: "t1", data: { schedule: { mon: [{ from: "09:00", to: "17:00" }] } } },
    });
    expect(editPatch(t, "nameAr", " ")).toEqual({ ok: true, patch: { key: "t1", data: { nameAr: null } } });
    expect(editPatch(t, "services", [" Cut ", ""])).toEqual({ ok: true, patch: { key: "t1", data: { services: ["Cut"] } } });
  });
});
