/**
 * Pure validation + planning for a pipeline editor draft (SP-07). No Prisma:
 * the service loads `CurrentPipeline`, calls validateDraft, and applies the
 * returned plan inside one transaction.
 *
 * Failure keys are returned as `{ok:false, key}` and surfaced as 400 with the
 * key as the message (frontend maps them to translated copy).
 */

export const STAGE_COLORS = ["ink", "info", "ok", "warn", "bad", "accent", "human"] as const;
export const MAX_LABEL = 60;
export const MAX_LOST_REASONS = 50;

export interface CurrentStage {
  id: string;
  key: string;
  label: string;
  labelAr: string;
  color: string;
  order: number;
  isTerminal: boolean;
  isWon: boolean;
  slaMinutes: number | null;
  /** Tickets currently sitting in this stage. */
  ticketCount: number;
}

export interface CurrentLostReason {
  id: string;
  /** Referenced by at least one ticket: must be archived, never deleted. */
  inUse: boolean;
  archived: boolean;
}

export interface CurrentPipeline {
  version: number;
  stages: CurrentStage[];
  lostReasons: CurrentLostReason[];
}

export interface DraftStage {
  id?: string;
  label: string;
  labelAr: string;
  color: string;
  order: number;
  slaMinutes?: number | null;
  isWon: boolean;
  isTerminal: boolean;
}

export interface DraftLostReason {
  id?: string;
  label: string;
  labelAr: string;
  order: number;
  archived?: boolean;
}

export interface DraftInput {
  version: number;
  name: string;
  nameAr: string;
  staleDays?: number | null;
  agentCanMove: boolean;
  assignsConversations: boolean;
  stages: DraftStage[];
  removed: Array<{ stageId: string; moveTo?: string | null }>;
  lostReasons: DraftLostReason[];
}

export interface DraftPlan {
  pipeline: {
    name: string;
    nameAr: string;
    staleDays: number | null;
    agentCanMove: boolean;
    assignsConversations: boolean;
  };
  stageCreates: Array<{
    key: string;
    label: string;
    labelAr: string;
    color: string;
    order: number;
    slaMinutes: number | null;
    isWon: boolean;
    isTerminal: boolean;
  }>;
  /** `data` never contains `key`: stage keys are immutable. */
  stageUpdates: Array<{
    id: string;
    data: {
      label: string;
      labelAr: string;
      color: string;
      order: number;
      slaMinutes: number | null;
      isWon: boolean;
      isTerminal: boolean;
    };
  }>;
  stageDeletes: Array<{ stageId: string; moveTo: string | null }>;
  lostReasonCreates: Array<{ label: string; labelAr: string; order: number }>;
  lostReasonUpdates: Array<{ id: string; label: string; labelAr: string; order: number; archived: boolean }>;
  lostReasonArchives: string[];
  lostReasonDeletes: string[];
}

export type DraftResult = { ok: true; plan: DraftPlan } | { ok: false; key: string };

const fail = (key: string): { ok: false; key: string } => ({ ok: false, key });

export function slugify(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "stage";
}

const okLabel = (s: unknown): s is string =>
  typeof s === "string" && s.trim().length >= 1 && s.trim().length <= MAX_LABEL;

export function validateDraft(current: CurrentPipeline, draft: DraftInput): DraftResult {
  // Pipeline-level fields
  if (!okLabel(draft.name) || !okLabel(draft.nameAr)) return fail("pipelines.invalid_name");
  if (
    draft.staleDays != null &&
    (!Number.isInteger(draft.staleDays) || draft.staleDays < 1 || draft.staleDays > 365)
  ) {
    return fail("pipelines.invalid_stale_days");
  }

  // Stage identity
  const currentById = new Map(current.stages.map((s) => [s.id, s]));
  const keptIds = new Set<string>();
  for (const s of draft.stages) {
    if (s.id !== undefined && s.id !== null && s.id !== "") {
      if (!currentById.has(s.id)) return fail("pipelines.unknown_stage");
      if (keptIds.has(s.id)) return fail("pipelines.unknown_stage");
      keptIds.add(s.id);
    }
  }
  const removedIds = new Set<string>();
  for (const r of draft.removed) {
    if (!currentById.has(r.stageId)) return fail("pipelines.unknown_stage");
    if (keptIds.has(r.stageId) || removedIds.has(r.stageId)) return fail("pipelines.stage_conflict");
    removedIds.add(r.stageId);
  }
  for (const s of current.stages) {
    if (!keptIds.has(s.id) && !removedIds.has(s.id)) return fail("pipelines.stage_missing");
  }

  // Per-stage fields
  for (const s of draft.stages) {
    if (!okLabel(s.label) || !okLabel(s.labelAr)) return fail("pipelines.invalid_label");
    if (!(STAGE_COLORS as readonly string[]).includes(s.color)) return fail("pipelines.invalid_color");
    if (s.isWon && !s.isTerminal) return fail("pipelines.won_must_be_terminal");
    if (s.slaMinutes != null && (!Number.isInteger(s.slaMinutes) || s.slaMinutes < 1)) {
      return fail("pipelines.invalid_sla");
    }
  }

  // Order: a permutation of 0..n-1
  const orders = draft.stages.map((s) => s.order).sort((a, b) => a - b);
  if (!orders.every((o, i) => o === i)) return fail("pipelines.invalid_order");

  // Stage-set rules
  if (!draft.stages.some((s) => !s.isTerminal)) return fail("pipelines.no_open_stage");
  const won = draft.stages.filter((s) => s.isWon).length;
  if (won === 0) return fail("pipelines.won_stage_required");
  if (won > 1) return fail("pipelines.multiple_won_stages");
  if (draft.stages.filter((s) => s.isTerminal && !s.isWon).length > 1) {
    return fail("pipelines.multiple_lost_stages");
  }

  // Removed stages with cards need a surviving existing target.
  const stageDeletes: DraftPlan["stageDeletes"] = [];
  for (const r of draft.removed) {
    const cur = currentById.get(r.stageId)!;
    const moveTo = r.moveTo ? r.moveTo : null;
    if (cur.ticketCount > 0) {
      if (!moveTo || !keptIds.has(moveTo)) return fail("pipelines.move_target_required");
    } else if (moveTo && !keptIds.has(moveTo)) {
      return fail("pipelines.move_target_required");
    }
    stageDeletes.push({ stageId: r.stageId, moveTo: cur.ticketCount > 0 ? moveTo : null });
  }

  // Lost reasons
  const reasonById = new Map(current.lostReasons.map((r) => [r.id, r]));
  const seenReasons = new Set<string>();
  let active = 0;
  for (const r of draft.lostReasons) {
    if (!okLabel(r.label) || !okLabel(r.labelAr)) return fail("pipelines.invalid_label");
    if (r.id) {
      if (!reasonById.has(r.id) || seenReasons.has(r.id)) return fail("pipelines.unknown_lost_reason");
      seenReasons.add(r.id);
    }
    if (!r.archived) active++;
  }
  if (active < 1 || active > MAX_LOST_REASONS) return fail("pipelines.lost_reasons_count");

  // Plan: stages
  const usedKeys = new Set(current.stages.map((s) => s.key));
  const stageCreates: DraftPlan["stageCreates"] = [];
  const stageUpdates: DraftPlan["stageUpdates"] = [];
  for (const s of draft.stages) {
    const common = {
      label: s.label.trim(),
      labelAr: s.labelAr.trim(),
      color: s.color,
      order: s.order,
      slaMinutes: s.slaMinutes ?? null,
      isWon: s.isWon,
      isTerminal: s.isTerminal,
    };
    if (s.id) {
      stageUpdates.push({ id: s.id, data: common });
    } else {
      const base = slugify(s.label);
      let key = base;
      for (let n = 2; usedKeys.has(key); n++) key = `${base}_${n}`;
      usedKeys.add(key);
      stageCreates.push({ key, ...common });
    }
  }

  // Plan: lost reasons
  const lostReasonCreates: DraftPlan["lostReasonCreates"] = [];
  const lostReasonUpdates: DraftPlan["lostReasonUpdates"] = [];
  const lostReasonArchives: string[] = [];
  const lostReasonDeletes: string[] = [];
  for (const r of draft.lostReasons) {
    const data = { label: r.label.trim(), labelAr: r.labelAr.trim(), order: r.order };
    if (!r.id) {
      if (r.archived) continue; // creating an already-archived reason is a no-op
      lostReasonCreates.push(data);
    } else {
      lostReasonUpdates.push({ id: r.id, ...data, archived: !!r.archived });
      if (r.archived && !reasonById.get(r.id)!.archived) lostReasonArchives.push(r.id);
    }
  }
  for (const cur of current.lostReasons) {
    if (seenReasons.has(cur.id) || cur.archived) continue;
    // Dropped from the draft: archive when tickets reference it, else delete.
    (cur.inUse ? lostReasonArchives : lostReasonDeletes).push(cur.id);
  }

  return {
    ok: true,
    plan: {
      pipeline: {
        name: draft.name.trim(),
        nameAr: draft.nameAr.trim(),
        staleDays: draft.staleDays ?? null,
        agentCanMove: draft.agentCanMove,
        assignsConversations: draft.assignsConversations,
      },
      stageCreates,
      stageUpdates,
      stageDeletes,
      lostReasonCreates,
      lostReasonUpdates,
      lostReasonArchives,
      lostReasonDeletes,
    },
  };
}
