import { validateDraft, slugify, type CurrentPipeline, type DraftInput } from "./stage-draft";

const stage = (id: string, order: number, o: Partial<CurrentPipeline["stages"][number]> = {}) => ({
  id, key: id, label: id, labelAr: id, color: "info", order, isTerminal: false, isWon: false, slaMinutes: null, ticketCount: 0, ...o,
});

const current = (): CurrentPipeline => ({
  version: 3,
  stages: [
    stage("new", 0),
    stage("work", 1, { ticketCount: 4 }),
    stage("won", 2, { isTerminal: true, isWon: true }),
    stage("lost", 3, { isTerminal: true }),
  ],
  lostReasons: [
    { id: "r1", inUse: true, archived: false },
    { id: "r2", inUse: false, archived: false },
    { id: "r3", inUse: false, archived: true },
  ],
});

const ds = (id: string | undefined, order: number, o: Record<string, unknown> = {}) => ({
  id, label: `L${order}`, labelAr: `ع${order}`, color: "info", order, isWon: false, isTerminal: false, ...o,
});

const draft = (): DraftInput => ({
  version: 3,
  name: "Sales", nameAr: "المبيعات",
  staleDays: null, agentCanMove: true, assignsConversations: false,
  stages: [
    ds("new", 0), ds("work", 1),
    ds("won", 2, { isWon: true, isTerminal: true }),
    ds("lost", 3, { isTerminal: true }),
  ],
  removed: [],
  lostReasons: [
    { id: "r1", label: "Price", labelAr: "السعر", order: 0 },
    { id: "r2", label: "Other", labelAr: "أخرى", order: 1 },
  ],
});

const key = (c: CurrentPipeline, d: DraftInput) => {
  const r = validateDraft(c, d);
  return r.ok ? "ok" : r.key;
};

describe("validateDraft", () => {
  it("accepts an unchanged pipeline", () => {
    expect(validateDraft(current(), draft()).ok).toBe(true);
  });

  it("fails with no open (non-terminal) stage", () => {
    const d = draft();
    d.stages = [ds("won", 0, { isWon: true, isTerminal: true }), ds("lost", 1, { isTerminal: true })];
    d.removed = [{ stageId: "new", moveTo: "won" }, { stageId: "work", moveTo: "won" }];
    expect(key(current(), d)).toBe("pipelines.no_open_stage");
  });

  it("fails when the only won stage is removed", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "won").map((s, i) => ({ ...s, order: i }));
    d.removed = [{ stageId: "won", moveTo: "new" }];
    expect(key(current(), d)).toBe("pipelines.won_stage_required");
  });

  it("fails with a second won stage", () => {
    const d = draft();
    d.stages.push(ds(undefined, 4, { isWon: true, isTerminal: true }));
    expect(key(current(), d)).toBe("pipelines.multiple_won_stages");
  });

  it("fails with a second lost stage", () => {
    const d = draft();
    d.stages.push(ds(undefined, 4, { isTerminal: true }));
    expect(key(current(), d)).toBe("pipelines.multiple_lost_stages");
  });

  it("allows a pipeline without a lost stage", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "lost");
    d.removed = [{ stageId: "lost", moveTo: "new" }];
    expect(key(current(), d)).toBe("ok");
  });

  it("requires a won stage to be terminal", () => {
    const d = draft();
    d.stages[2] = ds("won", 2, { isWon: true, isTerminal: false });
    expect(key(current(), d)).toBe("pipelines.won_must_be_terminal");
  });

  it("requires contiguous order from 0", () => {
    const d = draft();
    d.stages[3].order = 5;
    expect(key(current(), d)).toBe("pipelines.invalid_order");
    const d2 = draft();
    d2.stages.forEach((s) => (s.order += 1));
    expect(key(current(), d2)).toBe("pipelines.invalid_order");
  });

  it("validates label length in EN and AR", () => {
    const d = draft();
    d.stages[0].label = "";
    expect(key(current(), d)).toBe("pipelines.invalid_label");
    const d2 = draft();
    d2.stages[0].labelAr = "x".repeat(61);
    expect(key(current(), d2)).toBe("pipelines.invalid_label");
    const d3 = draft();
    d3.stages[0].label = "x".repeat(60);
    expect(key(current(), d3)).toBe("ok");
  });

  it("validates colour keys", () => {
    const d = draft();
    d.stages[0].color = "pink";
    expect(key(current(), d)).toBe("pipelines.invalid_color");
  });

  it("requires moveTo for a removed stage that has cards", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "work").map((s, i) => ({ ...s, order: i }));
    d.removed = [{ stageId: "work", moveTo: "" }];
    expect(key(current(), d)).toBe("pipelines.move_target_required");
    d.removed = [{ stageId: "work", moveTo: "ghost" }];
    expect(key(current(), d)).toBe("pipelines.move_target_required");
    d.removed = [{ stageId: "work", moveTo: "work" }];
    expect(key(current(), d)).toBe("pipelines.move_target_required");
  });

  it("does not require moveTo for an empty removed stage, and plans the delete", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "new").map((s, i) => ({ ...s, order: i }));
    d.removed = [{ stageId: "new", moveTo: null }];
    const r = validateDraft(current(), d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.stageDeletes).toEqual([{ stageId: "new", moveTo: null }]);
  });

  it("plans moves for a removed stage with cards", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "work").map((s, i) => ({ ...s, order: i }));
    d.removed = [{ stageId: "work", moveTo: "new" }];
    const r = validateDraft(current(), d);
    expect(r.ok && r.plan.stageDeletes).toEqual([{ stageId: "work", moveTo: "new" }]);
  });

  it("rejects stages that are neither kept nor removed, or unknown ids", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "work").map((s, i) => ({ ...s, order: i }));
    expect(key(current(), d)).toBe("pipelines.stage_missing");
    const d2 = draft();
    d2.stages[0].id = "ghost";
    expect(key(current(), d2)).toBe("pipelines.unknown_stage");
  });

  it("generates unique immutable keys for new stages from the English label", () => {
    const d = draft();
    d.stages.splice(1, 0, ds(undefined, 1, { label: "New" }), ds(undefined, 2, { label: "Follow Up!" }));
    d.stages.forEach((s, i) => (s.order = i));
    const r = validateDraft(current(), d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.stageCreates.map((s) => s.key)).toEqual(["new_2", "follow_up"]);
      // existing stages keep their keys: updates carry no key
      expect(r.plan.stageUpdates.every((u) => !("key" in u.data))).toBe(true);
    }
  });

  it("falls back to a generic key for a label with no latin characters", () => {
    expect(slugify("جديد")).toBe("stage");
    expect(slugify("  Hello  World ")).toBe("hello_world");
  });

  it("limits lost reasons to 1-50 active, with EN and AR labels", () => {
    const d = draft();
    d.lostReasons = [];
    expect(key(current(), d)).toBe("pipelines.lost_reasons_count");
    d.lostReasons = Array.from({ length: 51 }, (_, i) => ({ label: `r${i}`, labelAr: `ع${i}`, order: i }));
    expect(key(current(), d)).toBe("pipelines.lost_reasons_count");
    d.lostReasons = [{ label: "", labelAr: "x", order: 0 }];
    expect(key(current(), d)).toBe("pipelines.invalid_label");
    d.lostReasons = [{ id: "ghost", label: "a", labelAr: "ا", order: 0 }];
    expect(key(current(), d)).toBe("pipelines.unknown_lost_reason");
  });

  it("archives (never deletes) a lost reason in use, deletes an unused one, leaves archived alone", () => {
    const d = draft();
    d.lostReasons = [{ id: "r2", label: "Other", labelAr: "أخرى", order: 0 }]; // r1 (in use) dropped
    const r = validateDraft(current(), d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.lostReasonArchives).toEqual(["r1"]);
      expect(r.plan.lostReasonDeletes).toEqual([]);
    }
    const d2 = draft();
    d2.lostReasons = [{ id: "r1", label: "Price", labelAr: "السعر", order: 0 }]; // r2 (unused) dropped
    const r2 = validateDraft(current(), d2);
    expect(r2.ok && r2.plan.lostReasonDeletes).toEqual(["r2"]);
    expect(r2.ok && r2.plan.lostReasonArchives).toEqual([]);
  });

  it("archived:true on an existing reason archives it and does not count as active", () => {
    const d = draft();
    d.lostReasons = [
      { id: "r1", label: "Price", labelAr: "السعر", order: 0, archived: true },
      { id: "r2", label: "Other", labelAr: "أخرى", order: 1 },
    ];
    const r = validateDraft(current(), d);
    expect(r.ok && r.plan.lostReasonArchives).toEqual(["r1"]);
  });

  it("validates name and staleDays", () => {
    const d = draft();
    d.name = "";
    expect(key(current(), d)).toBe("pipelines.invalid_name");
    const d2 = draft();
    d2.staleDays = 0;
    expect(key(current(), d2)).toBe("pipelines.invalid_stale_days");
    const d3 = draft();
    d3.staleDays = 14;
    expect(key(current(), d3)).toBe("ok");
  });
});

describe("support pipeline protection", () => {
  const supportCurrent = (): CurrentPipeline => ({
    ...current(),
    key: "support",
    stages: [stage("open", 0), stage("work", 1), stage("won", 2, { isTerminal: true, isWon: true })],
  });
  const supportDraft = (): DraftInput => ({
    ...draft(),
    stages: [ds("open", 0), ds("work", 1), ds("won", 2, { isWon: true, isTerminal: true })],
  });

  it("refuses to remove the open stage", () => {
    const d = supportDraft();
    d.stages = [ds("work", 0), ds("won", 1, { isWon: true, isTerminal: true })];
    d.removed = [{ stageId: "open", moveTo: "work" }];
    expect(validateDraft(supportCurrent(), d)).toEqual({ ok: false, key: "pipelines.system_stage" });
  });

  it("refuses to make the open stage terminal", () => {
    const d = supportDraft();
    d.stages[0] = ds("open", 0, { isTerminal: true });
    expect(validateDraft(supportCurrent(), d)).toEqual({ ok: false, key: "pipelines.system_stage" });
  });

  it("allows renaming it and other stages; other pipelines are unrestricted", () => {
    const d = supportDraft();
    d.stages[0] = ds("open", 0, { label: "Fresh" });
    expect(validateDraft(supportCurrent(), d).ok).toBe(true);
    const other = { ...supportCurrent(), key: "renewals" };
    const d2 = supportDraft();
    d2.stages = [ds("work", 0), ds("won", 1, { isWon: true, isTerminal: true })];
    d2.removed = [{ stageId: "open", moveTo: "work" }];
    expect(validateDraft(other, d2).ok).toBe(true);
  });

  it("keeps a supplied valid moveTo even when the stage had no cards at load", () => {
    const d = draft();
    d.stages = d.stages.filter((s) => s.id !== "new");
    d.stages.forEach((s, i) => (s.order = i));
    d.removed = [{ stageId: "new", moveTo: "work" }];
    const r = validateDraft(current(), d);
    expect(r.ok && r.plan.stageDeletes).toEqual([{ stageId: "new", moveTo: "work" }]);
  });
});
