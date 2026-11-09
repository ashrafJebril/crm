import { describe, expect, it } from "vitest";
import {
  addLostReason,
  addStage,
  draftFromPipeline,
  hasChanges,
  moveStage,
  moveTargetsFor,
  removeLostReason,
  removeStage,
  setStageLost,
  setStageWon,
  toPayload,
  updateStage,
  validateDraft,
  type DraftPipelineInput,
} from "./draft";

const base = (): DraftPipelineInput => ({
  id: "p1",
  version: 3,
  name: "Sales",
  nameAr: "المبيعات",
  kind: "deals",
  staleDays: null,
  agentCanMove: true,
  assignsConversations: false,
  stages: [
    { id: "s1", key: "new", label: "New", labelAr: "جديد", color: "info", order: 0, slaMinutes: null, isWon: false, isTerminal: false, ticketCount: 2 },
    { id: "s2", key: "won", label: "Won", labelAr: "تم", color: "ok", order: 1, slaMinutes: null, isWon: true, isTerminal: true, ticketCount: 0 },
    { id: "s3", key: "lost", label: "Lost", labelAr: "خسارة", color: "bad", order: 2, slaMinutes: null, isWon: false, isTerminal: true, ticketCount: 1 },
  ],
  lostReasons: [{ id: "r1", label: "Price", labelAr: "السعر", order: 0 }],
});

const keys = (d: ReturnType<typeof draftFromPipeline>) => validateDraft(d).map((e) => e.key);

describe("draft", () => {
  it("round-trips an untouched pipeline with no changes", () => {
    const d = draftFromPipeline(base());
    expect(hasChanges(d, draftFromPipeline(base()))).toBe(false);
    expect(validateDraft(d)).toEqual([]);
    const p = toPayload(d);
    expect(p.version).toBe(3);
    expect(p.stages.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(p.removed).toEqual([]);
  });

  it("new stages are open, have no id, and get appended with contiguous order", () => {
    const d = addStage(draftFromPipeline(base()));
    expect(d.stages).toHaveLength(4);
    const s = d.stages[3];
    expect(s.id).toBeUndefined();
    expect(s.isTerminal).toBe(false);
    expect(d.stages.map((x) => x.order)).toEqual([0, 1, 2, 3]);
    const ps = toPayload(d).stages[3];
    expect(ps.id).toBeUndefined();
    expect("key" in ps).toBe(false);
  });

  it("requires labels in both languages (1-60 chars)", () => {
    let d = addStage(draftFromPipeline(base()));
    expect(keys(d)).toContain("pipelines.invalid_label");
    d = { ...d, stages: d.stages.map((s, i) => (i === 3 ? { ...s, label: "x".repeat(61), labelAr: "ب" } : s)) };
    expect(keys(d)).toContain("pipelines.invalid_label");
    d = { ...d, stages: d.stages.map((s, i) => (i === 3 ? { ...s, label: "Ok", labelAr: "ب" } : s)) };
    expect(keys(d)).not.toContain("pipelines.invalid_label");
  });

  it("requires a name in both languages", () => {
    const d = { ...draftFromPipeline(base()), nameAr: " " };
    expect(keys(d)).toContain("pipelines.invalid_name");
  });

  it("toggling won keeps exactly one won stage and makes it terminal", () => {
    let d = draftFromPipeline(base());
    d = setStageWon(d, d.stages[0].clientId, true);
    expect(d.stages.filter((s) => s.isWon).map((s) => s.id)).toEqual(["s1"]);
    expect(d.stages[0].isTerminal).toBe(true);
    d = setStageWon(d, d.stages[0].clientId, false);
    expect(keys(d)).toContain("pipelines.won_stage_required");
  });

  it("toggling lost keeps at most one lost stage", () => {
    let d = draftFromPipeline(base());
    d = setStageLost(d, d.stages[0].clientId, true);
    expect(d.stages.filter((s) => s.isTerminal && !s.isWon).map((s) => s.id)).toEqual(["s1"]);
    expect(d.stages[2].isTerminal).toBe(false);
    d = setStageLost(d, d.stages[0].clientId, false);
    expect(d.stages[0].isTerminal).toBe(false);
  });

  it("requires at least one open stage", () => {
    let d = draftFromPipeline(base());
    d = updateStage(d, "s1", { isTerminal: true });
    expect(keys(d)).toContain("pipelines.no_open_stage");
  });

  it("moveStage swaps and keeps order contiguous; edges are no-ops", () => {
    let d = draftFromPipeline(base());
    d = moveStage(d, d.stages[0].clientId, 1);
    expect(d.stages.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
    expect(d.stages.map((s) => s.order)).toEqual([0, 1, 2]);
    const same = moveStage(d, d.stages[0].clientId, -1);
    expect(same.stages.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
  });

  it("removing an unsaved stage needs no move target and is not sent as removed", () => {
    let d = addStage(draftFromPipeline(base()));
    d = removeStage(d, d.stages[3].clientId);
    expect(d.stages).toHaveLength(3);
    expect(d.removed).toEqual([]);
  });

  it("removing a stage with cards requires moveTo, which must survive", () => {
    let d = removeStage(draftFromPipeline(base()), "s1");
    expect(keys(d)).toContain("pipelines.move_target_required");
    d = removeStage(draftFromPipeline(base()), "s1", "s2");
    expect(keys(d)).not.toContain("pipelines.move_target_required");
    expect(toPayload(d).removed).toEqual([{ stageId: "s1", moveTo: "s2" }]);
    expect(d.stages.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(d.stages.map((s) => s.order)).toEqual([0, 1]);
  });

  it("a stage with no cards is removed without moveTo", () => {
    const d = removeStage(draftFromPipeline(base()), "s2");
    expect(toPayload(d).removed).toEqual([{ stageId: "s2" }]);
    expect(keys(d)).toContain("pipelines.won_stage_required");
  });

  it("a move target removed later in the same draft is invalid", () => {
    let d = removeStage(draftFromPipeline(base()), "s1", "s3");
    d = removeStage(d, "s3");
    expect(keys(d)).toContain("pipelines.move_target_required");
  });

  it("moveTargetsFor offers only surviving saved stages, never unsaved ones", () => {
    let d = addStage(draftFromPipeline(base()));
    expect(moveTargetsFor(d, "s1").map((s) => s.id)).toEqual(["s2", "s3"]);
    d = removeStage(d, "s3", "s2");
    expect(moveTargetsFor(d, "s1").map((s) => s.id)).toEqual(["s2"]);
  });

  it("validates SLA minutes and stale days", () => {
    let d = draftFromPipeline(base());
    d = { ...d, stages: d.stages.map((s, i) => (i === 0 ? { ...s, slaMinutes: -5 } : s)) };
    expect(keys(d)).toContain("pipelines.invalid_sla");
    d = draftFromPipeline(base());
    expect(keys({ ...d, staleDays: 0 })).toContain("pipelines.invalid_stale_days");
    expect(keys({ ...d, staleDays: 366 })).toContain("pipelines.invalid_stale_days");
    expect(keys({ ...d, staleDays: 1.5 })).toContain("pipelines.invalid_stale_days");
    expect(keys({ ...d, staleDays: 14 })).not.toContain("pipelines.invalid_stale_days");
  });

  it("lost reasons: 1-50 active, both labels required, sent in order", () => {
    let d = draftFromPipeline(base());
    d = removeLostReason(d, d.lostReasons[0].clientId);
    expect(keys(d)).toContain("pipelines.lost_reasons_count");
    d = addLostReason(d);
    expect(keys(d)).toContain("pipelines.invalid_label");
    d = { ...d, lostReasons: d.lostReasons.map((r) => ({ ...r, label: "Other", labelAr: "أخرى" })) };
    expect(validateDraft(d)).toEqual([]);
    expect(toPayload(d).lostReasons).toEqual([{ label: "Other", labelAr: "أخرى", order: 0 }]);
    let many = d;
    for (let i = 0; i < 50; i++) many = addLostReason(many);
    expect(keys(many)).toContain("pipelines.lost_reasons_count");
  });

  it("keeps ids for existing lost reasons", () => {
    const d = draftFromPipeline(base());
    expect(toPayload(d).lostReasons).toEqual([{ id: "r1", label: "Price", labelAr: "السعر", order: 0 }]);
  });

  it("hasChanges detects edits", () => {
    const orig = draftFromPipeline(base());
    expect(hasChanges({ ...orig, name: "X" }, orig)).toBe(true);
    expect(hasChanges(moveStage(orig, orig.stages[0].clientId, 1), orig)).toBe(true);
  });
});
