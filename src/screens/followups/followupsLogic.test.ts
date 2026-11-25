import { describe, expect, it } from "vitest";
import {
  buildActivityPayload,
  chunkIds,
  dueAfterKindChange,
  FALLBACK_TZ,
  pruneSelection,
  safeTz,
  fromLocalInput,
  formatDue,
  groupForDisplay,
  quickReschedule,
  toLocalInput,
  type QueueResponse,
} from "./followupsLogic";

const DUBAI = "Asia/Dubai"; // UTC+4, no DST
// 2026-11-09 10:00 UTC = 14:00 Dubai
const NOW = new Date("2026-11-09T10:00:00Z");

describe("quickReschedule", () => {
  it("plus1h adds an hour", () => {
    expect(quickReschedule(NOW, "plus1h", DUBAI).toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
  it("tomorrow9 is 09:00 Dubai tomorrow", () => {
    expect(quickReschedule(NOW, "tomorrow9", DUBAI).toISOString()).toBe("2026-11-10T05:00:00.000Z");
  });
  it("tomorrow9 uses the workspace date, not UTC date (late evening Dubai)", () => {
    // 21:30 UTC = 01:30 Dubai on Nov 10 -> tomorrow is Nov 11 09:00 Dubai
    const late = new Date("2026-11-09T21:30:00Z");
    expect(quickReschedule(late, "tomorrow9", DUBAI).toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });
  it("nextWeek is 09:00 Dubai seven days out", () => {
    expect(quickReschedule(NOW, "nextWeek", DUBAI).toISOString()).toBe("2026-11-16T05:00:00.000Z");
  });
});

describe("local datetime input", () => {
  it("round-trips in the workspace zone", () => {
    expect(toLocalInput("2026-11-10T05:00:00.000Z", DUBAI)).toBe("2026-11-10T09:00");
    expect(fromLocalInput("2026-11-10T09:00", DUBAI)?.toISOString()).toBe("2026-11-10T05:00:00.000Z");
  });
  it("rejects garbage", () => {
    expect(fromLocalInput("", DUBAI)).toBeNull();
    expect(fromLocalInput("nope", DUBAI)).toBeNull();
  });
});

describe("formatDue", () => {
  it("says Today / Tomorrow / Yesterday with the local time", () => {
    expect(formatDue("2026-11-09T11:30:00Z", NOW, DUBAI, "en")).toBe("Today 15:30");
    expect(formatDue("2026-11-10T06:00:00Z", NOW, DUBAI, "en")).toBe("Tomorrow 10:00");
    expect(formatDue("2026-11-08T06:00:00Z", NOW, DUBAI, "en")).toBe("Yesterday 10:00");
  });
  it("treats 23:30 Dubai as today and 00:30 Dubai as tomorrow", () => {
    expect(formatDue("2026-11-09T19:30:00Z", NOW, DUBAI, "en")).toBe("Today 23:30");
    expect(formatDue("2026-11-09T20:30:00Z", NOW, DUBAI, "en")).toBe("Tomorrow 00:30");
  });
  it("uses a date for farther days and Arabic words in ar", () => {
    expect(formatDue("2026-11-20T06:00:00Z", NOW, DUBAI, "en")).toMatch(/Nov/);
    expect(formatDue("2026-11-10T06:00:00Z", NOW, DUBAI, "ar")).toBe("غدًا 10:00");
    expect(formatDue("2026-11-09T11:30:00Z", NOW, DUBAI, "ar")).toBe("اليوم 15:30");
  });
});

describe("groupForDisplay", () => {
  const item = (id: string) => ({ id }) as never;
  const q: QueueResponse = {
    overdue: [item("a")],
    today: [],
    upcoming: [item("b"), item("c")],
    counts: { overdue: 1, today: 0, upcoming: 7 },
    nextCursorUpcoming: "x",
  };
  it("keeps order, uses server counts, and hides empty sections", () => {
    const g = groupForDisplay(q);
    expect(g.map((s) => s.key)).toEqual(["overdue", "upcoming"]);
    expect(g[1].count).toBe(7);
    expect(g[1].items).toHaveLength(2);
  });
  it("returns nothing for an empty queue", () => {
    expect(groupForDisplay({ ...q, overdue: [], upcoming: [], counts: { overdue: 0, today: 0, upcoming: 0 } })).toEqual([]);
  });
});

describe("invalid timezone", () => {
  it("safeTz falls back and the helpers do not throw", () => {
    expect(safeTz("Not/AZone")).toBe(FALLBACK_TZ);
    expect(safeTz("")).toBe(FALLBACK_TZ);
    expect(safeTz("Asia/Dubai")).toBe("Asia/Dubai");
    expect(() => formatDue("2026-11-09T19:30:00Z", NOW, "Bad/Zone", "en")).not.toThrow();
    expect(() => quickReschedule(NOW, "tomorrow9", "Bad/Zone")).not.toThrow();
    expect(toLocalInput("2026-11-09T19:30:00Z", "Bad/Zone")).toBe(toLocalInput("2026-11-09T19:30:00Z", FALLBACK_TZ));
  });
});

describe("quickReschedule plus1h", () => {
  it("floors to the minute", () => {
    const r = quickReschedule(new Date("2026-11-09T10:00:42.123Z"), "plus1h", DUBAI);
    expect(r.toISOString()).toBe("2026-11-09T11:00:00.000Z");
  });
});

describe("dueAfterKindChange", () => {
  const def = "2026-11-10T09:00";
  it("clears the scheduling default when switching to call/meeting untouched", () => {
    expect(dueAfterKindChange("call", def, false, def)).toBe("");
    expect(dueAfterKindChange("meeting", def, false, def)).toBe("");
  });
  it("keeps a user-entered due for call/meeting", () => {
    expect(dueAfterKindChange("call", "2026-11-12T10:00", true, def)).toBe("2026-11-12T10:00");
  });
  it("always clears for a note", () => {
    expect(dueAfterKindChange("note_log", "2026-11-12T10:00", true, def)).toBe("");
  });
  it("fills the default when a required kind has no due", () => {
    expect(dueAfterKindChange("follow_up", "", false, def)).toBe(def);
    expect(dueAfterKindChange("task", "2026-11-12T10:00", true, def)).toBe("2026-11-12T10:00");
  });
});

describe("buildActivityPayload", () => {
  const due = new Date("2026-11-10T09:00:00Z");
  const orig = { notes: "n", outcome: "o", dueAt: "2026-11-10T09:00:00.000Z" };
  const v = { title: " T ", notes: "n", outcome: "o", dueDate: due };
  it("omits dueAt when unchanged (even with sub-minute drift)", () => {
    expect(buildActivityPayload(v, orig)).not.toHaveProperty("dueAt");
    expect(buildActivityPayload({ ...v, dueDate: new Date("2026-11-10T09:00:30Z") }, orig)).not.toHaveProperty("dueAt");
  });
  it("sends dueAt when the minute changed", () => {
    expect(buildActivityPayload({ ...v, dueDate: new Date("2026-11-10T10:00:00Z") }, orig).dueAt).toBe("2026-11-10T10:00:00.000Z");
  });
  it("sends null for emptied notes/outcome/due on edit", () => {
    const p = buildActivityPayload({ title: "T", notes: " ", outcome: "", dueDate: null }, orig);
    expect(p).toMatchObject({ notes: null, outcome: null, dueAt: null });
  });
  it("does not send null for already-empty fields; create omits empties", () => {
    const p = buildActivityPayload({ title: "T", notes: "", outcome: "", dueDate: null }, { notes: null, outcome: null, dueAt: null });
    expect(p).toEqual({ title: "T" });
    expect(buildActivityPayload({ title: "T", notes: "", outcome: "", dueDate: null })).toEqual({ title: "T" });
    expect(buildActivityPayload(v).dueAt).toBe(due.toISOString());
  });
});

describe("pruneSelection / chunkIds", () => {
  it("drops ids no longer listed, keeping the same set when unchanged", () => {
    const s = new Set(["a", "b"]);
    expect([...pruneSelection(s, ["a", "c"])]).toEqual(["a"]);
    expect(pruneSelection(s, ["a", "b"])).toBe(s);
  });
  it("chunks in order without duplicates", () => {
    expect(chunkIds(["1", "2", "3", "2", "4", "5"], 2)).toEqual([["1", "2"], ["3", "4"], ["5"]]);
  });
});
