import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { KnowledgeSource } from "@/lib/types";
import { filterFaqs, isDuplicateQuestion, moveBy, moveId, orderChanged, questionKey } from "./faqModel";
import { formatWhen, retryNote, shouldPoll, sourceBadge } from "./knowledgeStatus";
import { canKeepValidRows, columnReportText, rowErrorLine, rowErrorTable, rowErrorsSummary } from "./typedErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

type S = Pick<KnowledgeSource, "kind" | "status" | "publishState" | "pageCounts">;
const src = (over: Partial<S> = {}): S => ({ kind: "website", status: "ready", publishState: "none", pageCounts: {}, ...over });

describe("knowledge status", () => {
  it("source badge priority", () => {
    // Each step down the list only shows when nothing above it applies.
    const partial = { pageCounts: { synced: 4, needs_login: 1 } };
    expect(sourceBadge(src({ status: "processing", publishState: "pending", ...partial }))).toBe("syncing");
    expect(sourceBadge(src({ status: "queued", publishState: "pending", ...partial }))).toBe("queued");
    expect(sourceBadge(src({ status: "failed", publishState: "pending", ...partial }))).toBe("failed");
    expect(sourceBadge(src({ status: "paused", publishState: "pending", ...partial }))).toBe("paused");
    expect(sourceBadge(src({ status: "ready", publishState: "pending", ...partial }))).toBe("pending");
    expect(sourceBadge(src({ status: "ready", publishState: "published", ...partial }))).toBe("partial");
    expect(sourceBadge(src({ pageCounts: { blocked: 2 } }))).toBe("partial");
    expect(sourceBadge(src({ pageCounts: { error: 1 } }))).toBe("partial");
    // Removed and capped pages are not problems.
    expect(sourceBadge(src({ pageCounts: { synced: 3, removed: 2, capped: 5 } }))).toBe("synced");
    // Files: their statuses only.
    expect(sourceBadge(src({ kind: "file", status: "processing" }))).toBe("syncing");
    expect(sourceBadge(src({ kind: "file", status: "ready" }))).toBe("synced");
    expect(shouldPoll([{ status: "ready" }, { status: "queued" }])).toBe(true);
    expect(shouldPoll([{ status: "ready" }, { status: "failed" }])).toBe(false);
  });

  it("files never get the website failure wording", () => {
    expect(retryNote({ kind: "file", status: "queued", consecutiveFailures: 1 }, en)).toBe("Retrying after a temporary problem");
    expect(retryNote({ kind: "typed_doc", status: "failed", consecutiveFailures: 1 }, en)).toBeNull();
    expect(retryNote({ kind: "website", status: "ready", consecutiveFailures: 2 }, en)).toBe("Failed 2 times in a row");
    expect(retryNote({ kind: "website", status: "ready", consecutiveFailures: 0 }, en)).toBeNull();
    // Latin digits in Arabic dates.
    expect(formatWhen("2026-11-17T10:00:00Z", "ar", "Asia/Riyadh")).toMatch(/2026/);
    expect(formatWhen(null, "en")).toBe("—");
  });
});

describe("faq model", () => {
  it("faq duplicate and reorder model", () => {
    const faqs = [
      { id: "a", question: "Do you have parking?", answer: "Yes" },
      { id: "b", question: "Open on Friday?", answer: "From 4 pm" },
    ];
    expect(questionKey("  Do  YOU have parking? ")).toBe("do you have parking?");
    expect(isDuplicateQuestion("do you   HAVE parking?", faqs)).toBe(true);
    expect(isDuplicateQuestion("Do you have parking?", faqs, "a")).toBe(false); // editing itself
    expect(isDuplicateQuestion("Do you deliver?", faqs)).toBe(false);
    expect(isDuplicateQuestion("   ", faqs)).toBe(false);

    const ids = ["a", "b", "c", "d"];
    expect(moveId(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveId(ids, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveId(ids, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveBy(ids, "a", -1)).toEqual(ids); // already first
    expect(moveBy(ids, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveBy(ids, "d", 1)).toEqual(ids);
    expect(orderChanged(ids, moveBy(ids, "b", 1))).toBe(true);
    expect(orderChanged(ids, [...ids])).toBe(false);
    expect(filterFaqs(faqs, "friday").map((f) => f.id)).toEqual(["b"]);
    expect(filterFaqs(faqs, "yes").map((f) => f.id)).toEqual(["a"]);
    expect(filterFaqs(faqs, " ")).toHaveLength(2);
  });
});

describe("typed errors", () => {
  it("typed error report text names the row and column in both languages", () => {
    const rows = {
      rowErrors: [
        { row: 4, column: "price", error: "number" },
        { row: 7, column: "product_name", error: "required" },
      ],
      total: 2,
      validRows: 4,
    };
    const t = rowErrorTable(rows, en);
    expect(t.rows.map((r) => r.text)).toEqual(["Row 4: price must be a number of 0 or more.", "Row 7: product_name is required."]);
    expect(t.more).toBe(0);
    const tAr = rowErrorTable(rows, ar);
    expect(tAr.rows[0].text).toBe("الصف 4: price يجب أن يكون رقمًا يساوي 0 أو أكثر.");
    expect(tAr.rows[1].text).toMatch(/الصف 7: product_name/);
    expect(rowErrorsSummary(rows)).toEqual(["2 problems found in the rows (4 valid rows).", "وُجدت 2 مشكلة في الصفوف (4 صفًا صالحًا)."]);
    expect(canKeepValidRows(rows)).toBe(4);
    expect(canKeepValidRows({ ...rows, validRows: 0 })).toBeNull();

    const cols = columnReportText({ missing: ["valid_to"], unknown: ["notes"] });
    expect(cols[0]).toContain("valid_to");
    expect(cols[0]).toContain("notes");
    expect(cols[1]).toMatch(ARABIC);
    expect(cols[1]).toContain("valid_to");

    const tooMany = { rowErrors: [{ row: null, column: null, error: "too_many_rows" }], total: 1, validRows: 0 };
    expect(rowErrorLine({ row: null, column: null, error: "too_many_rows" }, en)).toMatch(/more than 2,000 rows/);
    expect(canKeepValidRows(tooMany)).toBeNull();
    // Reported rows are capped; the rest are counted.
    expect(rowErrorTable({ rowErrors: rows.rowErrors, total: 150 }, en, 100).more).toBe(148);
  });
});
