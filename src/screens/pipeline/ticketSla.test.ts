import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { SLA_DUE_SOON_MS, formatSlaDue, slaBadge, slaState, ticketSlaState } from "./ticketSla";

const en = makeTx("en");
const ar = makeTx("ar");
const now = new Date("2026-11-16T09:00:00.000Z");
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
const H = 60 * 60 * 1000;

describe("slaState", () => {
  it("overdue badge when now > slaDueAt and not terminal", () => {
    // Open stage, past due: overdue, with the "Overdue" badge.
    expect(slaState({ slaDueAt: at(-1), stageIsTerminal: false }, now)).toBe("breached");
    expect(slaBadge("breached", at(-1), "UTC", en)?.label).toBe("Overdue");
    expect(slaBadge("breached", at(-1), "UTC", en)?.tone).toBe("bad");
    // Terminal stage, past due: finished, no badge.
    expect(slaState({ slaDueAt: at(-5 * H), stageIsTerminal: true }, now)).toBe("finished");
    expect(slaBadge("finished", at(-5 * H), "UTC", en)).toBeNull();
    // Within 24 h: due soon; beyond: on track.
    expect(slaState({ slaDueAt: at(2 * H), stageIsTerminal: false }, now)).toBe("due_soon");
    expect(slaState({ slaDueAt: at(SLA_DUE_SOON_MS + 1), stageIsTerminal: false }, now)).toBe("on_track");
    // No due date.
    expect(slaState({ slaDueAt: null, stageIsTerminal: false }, now)).toBe("none");
    expect(slaState({ slaDueAt: undefined, stageIsTerminal: false }, now)).toBe("none");
    // Boundaries: exactly at slaDueAt is not overdue; exactly 24 h is due soon.
    expect(slaState({ slaDueAt: at(0), stageIsTerminal: false }, now)).toBe("due_soon");
    expect(slaState({ slaDueAt: at(SLA_DUE_SOON_MS), stageIsTerminal: false }, now)).toBe("due_soon");
    expect(SLA_DUE_SOON_MS).toBe(86_400_000);
  });

  it("accepts Date values and treats a malformed date as no SLA", () => {
    expect(slaState({ slaDueAt: new Date(now.getTime() - 1), stageIsTerminal: false }, now)).toBe("breached");
    expect(slaState({ slaDueAt: "garbage", stageIsTerminal: false }, now)).toBe("none");
  });

  it("ticketSlaState reads the stage, falling back to closedAt", () => {
    expect(ticketSlaState({ slaDueAt: at(-1) }, true, now)).toBe("finished");
    expect(ticketSlaState({ slaDueAt: at(-1), stage: { isTerminal: false } }, undefined, now)).toBe("breached");
    expect(ticketSlaState({ slaDueAt: at(-1), closedAt: at(-2) }, undefined, now)).toBe("finished");
    expect(ticketSlaState({ slaDueAt: at(-1), closedAt: null }, undefined, now)).toBe("breached");
  });
});

describe("slaBadge", () => {
  it("sla badge text in both languages uses the workspace timezone and Latin digits", () => {
    // 11:30 UTC is 14:30 in Riyadh (UTC+3).
    const due = "2026-11-17T11:30:00.000Z";
    const eBadge = slaBadge("on_track", due, "Asia/Riyadh", en)!;
    const aBadge = slaBadge("on_track", due, "Asia/Riyadh", ar)!;
    expect(eBadge.label).toMatch(/^Due /);
    expect(eBadge.label).toContain("14:30");
    expect(eBadge.label).toContain("17");
    expect(aBadge.label).toMatch(/^تستحق /);
    expect(aBadge.label).toContain("14:30");
    expect(aBadge.label).not.toMatch(/[٠-٩۰-۹]/);
    expect(aBadge.label).toMatch(/[؀-ۿ]/);
    // Same instant in UTC shows 11:30.
    expect(formatSlaDue(due, "UTC", en)).toContain("11:30");
    // A bad timezone falls back instead of throwing.
    expect(() => formatSlaDue(due, "Not/AZone", en)).not.toThrow();

    expect(slaBadge("breached", due, "Asia/Riyadh", ar)!.label).toBe("متأخرة");
    expect(slaBadge("breached", due, "Asia/Riyadh", ar)!.title).toContain("14:30");
    expect(slaBadge("due_soon", due, "Asia/Riyadh", en)!.label).toBe("Due soon");
    expect(slaBadge("due_soon", due, "Asia/Riyadh", ar)!.label).toBe("تستحق قريبًا");
    expect(slaBadge("none", null, "Asia/Riyadh", en)!.label).toBe("No SLA");
    expect(slaBadge("none", null, "Asia/Riyadh", ar)!.label).toBe("بلا مهلة");
  });
});

describe("SLA is a support feature (final review I1)", () => {
  it("slaShownFor: only pipelines of kind support", async () => {
    const { slaShownFor } = await import("./ticketSla");
    expect(slaShownFor("support")).toBe(true);
    for (const k of ["deals", "leads", "sales", "", undefined, null]) expect(slaShownFor(k as never)).toBe(false);
  });

  it("no SLA chip on a sales card, even when its slaDueAt is past; the support card is unchanged", async () => {
    const { cardSupportBits } = await import("./ticketSla");
    const overdue = { slaDueAt: at(-H), closedAt: null, priority: "normal", attachmentCount: 0 };
    expect(cardSupportBits(overdue, false, false, now)).toEqual({ show: false, sla: null });
    expect(cardSupportBits(overdue, false, true, now)).toEqual({ show: true, sla: "breached" });
    // A sales card still shows its priority chip and file count.
    expect(cardSupportBits({ ...overdue, priority: "urgent" }, false, false, now)).toEqual({ show: true, sla: null });
    expect(cardSupportBits({ ...overdue, attachmentCount: 2 }, false, false, now)).toEqual({ show: true, sla: null });
    // Support: finished / none never show the chip row on their own.
    expect(cardSupportBits({ ...overdue, slaDueAt: null }, false, true, now)).toEqual({ show: false, sla: "none" });
  });
});
