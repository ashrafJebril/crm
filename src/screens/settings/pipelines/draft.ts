/**
 * Pure draft model for the pipeline editor. It mirrors the server rules in
 * backend/src/pipelines (stage-draft.ts) so errors show before Save; the
 * server stays the source of truth and its error keys are reused here.
 */
import type { StageColor } from "@/lib/types";

export const STAGE_COLORS: readonly StageColor[] = ["ink", "info", "ok", "warn", "bad", "accent", "human"];
export const MAX_LABEL = 60;
export const MAX_LOST_REASONS = 50;

export interface DraftStageInput {
  id: string;
  key?: string;
  label: string;
  labelAr: string;
  color: StageColor;
  order: number;
  slaMinutes: number | null;
  isWon: boolean;
  isTerminal: boolean;
  /** Cards currently in the stage (GET /pipelines/:id). */
  ticketCount?: number;
}

export interface DraftReasonInput {
  id: string;
  label: string;
  labelAr: string;
  order: number;
}

/** Shape of GET /pipelines/:id (also the 409 `current`). */
export interface DraftPipelineInput {
  id: string;
  version: number;
  name: string;
  nameAr: string;
  kind?: string;
  isDefault?: boolean;
  archivedAt?: string | null;
  staleDays: number | null;
  agentCanMove: boolean;
  assignsConversations: boolean;
  stages: DraftStageInput[];
  lostReasons: DraftReasonInput[];
}

export interface DraftStage {
  /** Stable UI key: the server id for saved stages, a generated one for new. */
  clientId: string;
  id?: string;
  key?: string;
  label: string;
  labelAr: string;
  color: StageColor;
  order: number;
  slaMinutes: number | null;
  isWon: boolean;
  isTerminal: boolean;
  ticketCount: number;
}

export interface DraftReason {
  clientId: string;
  id?: string;
  label: string;
  labelAr: string;
}

export interface DraftRemoved {
  stageId: string;
  moveTo?: string;
  ticketCount: number;
  label: string;
  labelAr: string;
}

export interface PipelineDraft {
  pipelineId: string;
  version: number;
  name: string;
  nameAr: string;
  staleDays: number | null;
  agentCanMove: boolean;
  assignsConversations: boolean;
  stages: DraftStage[];
  removed: DraftRemoved[];
  lostReasons: DraftReason[];
}

export interface DraftPayload {
  version: number;
  name: string;
  nameAr: string;
  staleDays: number | null;
  agentCanMove: boolean;
  assignsConversations: boolean;
  stages: Array<{
    id?: string;
    label: string;
    labelAr: string;
    color: StageColor;
    order: number;
    slaMinutes: number | null;
    isWon: boolean;
    isTerminal: boolean;
  }>;
  removed: Array<{ stageId: string; moveTo?: string }>;
  lostReasons: Array<{ id?: string; label: string; labelAr: string; order: number }>;
}

export interface DraftError {
  /** Server error key, e.g. "pipelines.no_open_stage". */
  key: string;
  /** clientId of the offending stage / reason, when the error is about one. */
  stage?: string;
  reason?: string;
  /** removed stageId, for a missing move target. */
  removedStage?: string;
}

let seq = 0;
const nextId = (p: string) => `${p}-new-${++seq}`;

const renumber = (stages: DraftStage[]): DraftStage[] => stages.map((s, i) => (s.order === i ? s : { ...s, order: i }));

export function draftFromPipeline(p: DraftPipelineInput): PipelineDraft {
  return {
    pipelineId: p.id,
    version: p.version,
    name: p.name,
    nameAr: p.nameAr,
    staleDays: p.staleDays ?? null,
    agentCanMove: p.agentCanMove,
    assignsConversations: p.assignsConversations,
    stages: [...p.stages]
      .sort((a, b) => a.order - b.order)
      .map((s, i) => ({
        clientId: s.id,
        id: s.id,
        key: s.key,
        label: s.label,
        labelAr: s.labelAr,
        color: s.color,
        order: i,
        slaMinutes: s.slaMinutes ?? null,
        isWon: s.isWon,
        isTerminal: s.isTerminal,
        ticketCount: s.ticketCount ?? 0,
      })),
    removed: [],
    lostReasons: [...p.lostReasons]
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ clientId: r.id, id: r.id, label: r.label, labelAr: r.labelAr })),
  };
}

export function toPayload(d: PipelineDraft): DraftPayload {
  return {
    version: d.version,
    name: d.name.trim(),
    nameAr: d.nameAr.trim(),
    staleDays: d.staleDays,
    agentCanMove: d.agentCanMove,
    assignsConversations: d.assignsConversations,
    stages: d.stages.map((s, i) => ({
      ...(s.id ? { id: s.id } : {}),
      label: s.label.trim(),
      labelAr: s.labelAr.trim(),
      color: s.color,
      order: i,
      slaMinutes: s.slaMinutes,
      isWon: s.isWon,
      isTerminal: s.isTerminal || s.isWon,
    })),
    removed: d.removed.map((r) => (r.moveTo ? { stageId: r.stageId, moveTo: r.moveTo } : { stageId: r.stageId })),
    lostReasons: d.lostReasons.map((r, i) => ({
      ...(r.id ? { id: r.id } : {}),
      label: r.label.trim(),
      labelAr: r.labelAr.trim(),
      order: i,
    })),
  };
}

export function hasChanges(a: PipelineDraft, b: PipelineDraft): boolean {
  return JSON.stringify(toPayload(a)) !== JSON.stringify(toPayload(b));
}

// ── stages ──────────────────────────────────────────────────────────────

export function addStage(d: PipelineDraft): PipelineDraft {
  const stage: DraftStage = {
    clientId: nextId("stage"),
    label: "",
    labelAr: "",
    color: "info",
    order: d.stages.length,
    slaMinutes: null,
    isWon: false,
    isTerminal: false,
    ticketCount: 0,
  };
  const stages = [...d.stages, stage];
  return { ...d, stages: renumber(stages) };
}

export function updateStage(d: PipelineDraft, clientId: string, patch: Partial<DraftStage>): PipelineDraft {
  return { ...d, stages: d.stages.map((s) => (s.clientId === clientId ? { ...s, ...patch } : s)) };
}

/** `by` of -1 moves up/left, +1 down/right. Edges are no-ops. */
export function moveStage(d: PipelineDraft, clientId: string, by: -1 | 1): PipelineDraft {
  const i = d.stages.findIndex((s) => s.clientId === clientId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.stages.length) return d;
  const stages = [...d.stages];
  [stages[i], stages[j]] = [stages[j], stages[i]];
  return { ...d, stages: renumber(stages) };
}

/** Drag-and-drop reorder: move the stage at `from` to index `to`. */
export function reorderStages(d: PipelineDraft, from: number, to: number): PipelineDraft {
  if (from === to || from < 0 || to < 0 || from >= d.stages.length || to >= d.stages.length) return d;
  const stages = [...d.stages];
  const [m] = stages.splice(from, 1);
  stages.splice(to, 0, m);
  return { ...d, stages: renumber(stages) };
}

export function setStageWon(d: PipelineDraft, clientId: string, won: boolean): PipelineDraft {
  return {
    ...d,
    stages: d.stages.map((s) => {
      if (s.clientId === clientId) return { ...s, isWon: won, isTerminal: won };
      // Exactly one won stage: marking another one won clears the previous.
      if (won && s.isWon) return { ...s, isWon: false, isTerminal: false };
      return s;
    }),
  };
}

export function setStageLost(d: PipelineDraft, clientId: string, lost: boolean): PipelineDraft {
  return {
    ...d,
    stages: d.stages.map((s) => {
      if (s.clientId === clientId) return { ...s, isWon: false, isTerminal: lost };
      // At most one lost stage.
      if (lost && s.isTerminal && !s.isWon) return { ...s, isTerminal: false };
      return s;
    }),
  };
}

/**
 * Remove a stage. A saved stage is recorded in `removed` (with its move
 * target, if any); an unsaved one is simply dropped.
 */
export function removeStage(d: PipelineDraft, clientId: string, moveTo?: string): PipelineDraft {
  const s = d.stages.find((x) => x.clientId === clientId);
  if (!s) return d;
  const stages = renumber(d.stages.filter((x) => x.clientId !== clientId));
  if (!s.id) return { ...d, stages };
  const entry: DraftRemoved = {
    stageId: s.id,
    ...(moveTo ? { moveTo } : {}),
    ticketCount: s.ticketCount,
    label: s.label,
    labelAr: s.labelAr,
  };
  return { ...d, stages, removed: [...d.removed, entry] };
}

/** Change/choose the move target of an already removed stage. */
export function setRemovedMoveTo(d: PipelineDraft, stageId: string, moveTo: string | undefined): PipelineDraft {
  return {
    ...d,
    removed: d.removed.map((r) => (r.stageId === stageId ? { stageId: r.stageId, ticketCount: r.ticketCount, label: r.label, labelAr: r.labelAr, ...(moveTo ? { moveTo } : {}) } : r)),
  };
}

/** Put a removed stage back (drops the removal, restores it at the end). */
export function restoreStage(d: PipelineDraft, stageId: string, original: PipelineDraft): PipelineDraft {
  const orig = original.stages.find((s) => s.id === stageId);
  if (!orig) return d;
  return {
    ...d,
    removed: d.removed.filter((r) => r.stageId !== stageId),
    stages: renumber([...d.stages, { ...orig }]),
  };
}

/**
 * Stages a removed stage's cards may move to: saved stages (they have an id)
 * that survive this draft. Stages created in the same unsaved draft are not
 * offered: the server needs an existing stage.
 */
export function moveTargetsFor(d: PipelineDraft, clientId: string): DraftStage[] {
  return d.stages.filter((s) => s.id && s.clientId !== clientId);
}

// ── lost reasons ────────────────────────────────────────────────────────

export function addLostReason(d: PipelineDraft): PipelineDraft {
  return { ...d, lostReasons: [...d.lostReasons, { clientId: nextId("reason"), label: "", labelAr: "" }] };
}

export function updateLostReason(d: PipelineDraft, clientId: string, patch: Partial<DraftReason>): PipelineDraft {
  return { ...d, lostReasons: d.lostReasons.map((r) => (r.clientId === clientId ? { ...r, ...patch } : r)) };
}

export function removeLostReason(d: PipelineDraft, clientId: string): PipelineDraft {
  return { ...d, lostReasons: d.lostReasons.filter((r) => r.clientId !== clientId) };
}

export function moveLostReason(d: PipelineDraft, clientId: string, by: -1 | 1): PipelineDraft {
  const i = d.lostReasons.findIndex((r) => r.clientId === clientId);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.lostReasons.length) return d;
  const lostReasons = [...d.lostReasons];
  [lostReasons[i], lostReasons[j]] = [lostReasons[j], lostReasons[i]];
  return { ...d, lostReasons };
}

// ── validation ──────────────────────────────────────────────────────────

const labelOk = (s: string) => {
  const n = s.trim().length;
  return n >= 1 && n <= MAX_LABEL;
};

export function validateDraft(d: PipelineDraft): DraftError[] {
  const errors: DraftError[] = [];
  if (!labelOk(d.name) || !labelOk(d.nameAr)) errors.push({ key: "pipelines.invalid_name" });

  if (d.staleDays !== null && (!Number.isInteger(d.staleDays) || d.staleDays < 1 || d.staleDays > 365)) {
    errors.push({ key: "pipelines.invalid_stale_days" });
  }

  for (const s of d.stages) {
    if (!labelOk(s.label) || !labelOk(s.labelAr)) errors.push({ key: "pipelines.invalid_label", stage: s.clientId });
    if (s.slaMinutes !== null && (!Number.isInteger(s.slaMinutes) || s.slaMinutes < 1)) {
      errors.push({ key: "pipelines.invalid_sla", stage: s.clientId });
    }
  }

  const terminal = (s: DraftStage) => s.isTerminal || s.isWon;
  if (!d.stages.some((s) => !terminal(s))) errors.push({ key: "pipelines.no_open_stage" });
  const won = d.stages.filter((s) => s.isWon).length;
  if (won === 0) errors.push({ key: "pipelines.won_stage_required" });
  if (won > 1) errors.push({ key: "pipelines.multiple_won_stages" });
  if (d.stages.filter((s) => s.isTerminal && !s.isWon).length > 1) errors.push({ key: "pipelines.multiple_lost_stages" });

  const survivingSaved = new Set(d.stages.filter((s) => s.id).map((s) => s.id as string));
  for (const r of d.removed) {
    if (r.ticketCount > 0 && (!r.moveTo || !survivingSaved.has(r.moveTo))) {
      errors.push({ key: "pipelines.move_target_required", removedStage: r.stageId });
    }
  }

  const active = d.lostReasons.length;
  if (active < 1 || active > MAX_LOST_REASONS) errors.push({ key: "pipelines.lost_reasons_count" });
  for (const r of d.lostReasons) {
    if (!labelOk(r.label) || !labelOk(r.labelAr)) errors.push({ key: "pipelines.invalid_label", reason: r.clientId });
  }
  return errors;
}

/** English / Arabic message for a server or client draft error key. */
export const DRAFT_ERROR_TEXT: Record<string, [string, string]> = {
  "pipelines.invalid_name": ["Pipeline name is required in English and Arabic (up to 60 characters).", "اسم المسار مطلوب بالإنجليزية والعربية (حتى 60 حرفاً)."],
  "pipelines.invalid_stale_days": ["Stale days must be a whole number from 1 to 365, or empty.", "أيام الركود يجب أن تكون عدداً صحيحاً من 1 إلى 365، أو فارغة."],
  "pipelines.invalid_label": ["Every label needs English and Arabic text (up to 60 characters).", "كل تسمية تحتاج نصاً بالإنجليزية والعربية (حتى 60 حرفاً)."],
  "pipelines.invalid_sla": ["SLA minutes must be a positive whole number.", "دقائق اتفاقية الخدمة يجب أن تكون عدداً صحيحاً موجباً."],
  "pipelines.invalid_color": ["Invalid stage colour.", "لون المرحلة غير صالح."],
  "pipelines.invalid_order": ["Stage order is invalid.", "ترتيب المراحل غير صالح."],
  "pipelines.no_open_stage": ["Keep at least one open stage (not won or lost).", "أبقِ مرحلة مفتوحة واحدة على الأقل (غير رابحة أو خاسرة)."],
  "pipelines.won_stage_required": ["A pipeline needs exactly one Won stage.", "يحتاج المسار إلى مرحلة فوز واحدة بالضبط."],
  "pipelines.multiple_won_stages": ["Only one stage can be Won.", "يمكن أن تكون مرحلة واحدة فقط للفوز."],
  "pipelines.multiple_lost_stages": ["Only one stage can be Lost.", "يمكن أن تكون مرحلة واحدة فقط للخسارة."],
  "pipelines.move_target_required": ["Choose where to move the cards of each removed stage.", "اختر وجهة نقل بطاقات كل مرحلة محذوفة."],
  "pipelines.lost_reasons_count": ["Keep between 1 and 50 lost reasons.", "أبقِ ما بين 1 و50 سبب خسارة."],
  "pipelines.cannot_archive_default": ["The default pipeline cannot be archived.", "لا يمكن أرشفة المسار الافتراضي."],
  "pipelines.cannot_archive_support": ["The support pipeline cannot be archived.", "لا يمكن أرشفة مسار الدعم."],
  "pipelines.archived": ["This pipeline is archived.", "هذا المسار مؤرشف."],
  "pipelines.won_must_be_terminal": ["A Won stage must be a closing stage.", "يجب أن تكون مرحلة الفوز مرحلة إغلاق."],
  "pipelines.unknown_stage": ["A stage in the draft no longer exists. Reload and try again.", "مرحلة في المسودة لم تعد موجودة. أعد التحميل وحاول مجدداً."],
  "pipelines.stage_missing": ["A stage is missing from the draft. Reload and try again.", "مرحلة مفقودة من المسودة. أعد التحميل وحاول مجدداً."],
  "pipelines.stage_conflict": ["A stage cannot be both kept and removed.", "لا يمكن إبقاء المرحلة وحذفها معاً."],
  "pipelines.unknown_lost_reason": ["A lost reason no longer exists. Reload and try again.", "سبب خسارة لم يعد موجوداً. أعد التحميل وحاول مجدداً."],
  "pipelines.invalid_lost_reason": ["That lost reason is not valid for this pipeline.", "سبب الخسارة غير صالح لهذا المسار."],
};
