import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import type { AudienceGroup, AudienceRefAudience, AudienceRefCampaign, Segment, TagReferences } from "@/lib/types";
import { AUDIENCE_LIMITS, pathOfReference, type Path } from "./rulesModel";

/**
 * SP-16 copy for every audience error key (backend segments/audience-errors.ts),
 * the tag-delete key (tags/tag-errors.ts) and `campaigns.audience_missing`.
 * The backend puts the key in `message` and extras next to it (`ApiError.body`).
 * Pure, so the test checks every key in both languages.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const num = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n.toLocaleString("en-US") : null;
};
const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null && !Array.isArray(v);

const REF_NAMES: Record<string, [string, string]> = {
  segmentId: ["group or audience", "المجموعة أو الجمهور"],
  pipelineId: ["pipeline", "المسار"],
  stageId: ["pipeline stage", "مرحلة المسار"],
  defId: ["custom field", "الحقل المخصص"],
  campaignId: ["campaign", "الحملة"],
};

const REASON_COPY: Record<string, CopyFn> = {
  not_object: () => ["A condition is malformed. Remove it and add it again.", "أحد الشروط غير صالح. احذفه وأضفه من جديد."],
  bad_version: () => ["These rules come from a newer version. Reload the page.", "هذه الشروط من إصدار أحدث. أعد تحميل الصفحة."],
  bad_op: () => ["Choose a valid option for this condition.", "اختر خيارًا صالحًا لهذا الشرط."],
  bad_group: () => ["A group of conditions is malformed. Remove it and add it again.", "إحدى مجموعات الشروط غير صالحة. احذفها وأضفها من جديد."],
  empty_group: () => ["A group needs at least one condition. Add one or remove the group.", "تحتاج المجموعة إلى شرط واحد على الأقل. أضف شرطًا أو احذف المجموعة."],
  unknown_field: () => ["This kind of condition isn't supported. Remove it.", "هذا النوع من الشروط غير مدعوم. احذفه."],
  bad_value: () => ["Fill in this condition's value.", "أدخل قيمة هذا الشرط."],
  bad_id: () => ["Choose what this condition refers to.", "اختر ما يشير إليه هذا الشرط."],
  bad_reltime: () => ["Enter a whole number from 1 to 1000 and a unit.", "أدخل عددًا صحيحًا من 1 إلى 1000 ووحدة."],
  bad_date: () => ["Enter a valid date.", "أدخل تاريخًا صالحًا."],
  too_many_values: () => [
    `Choose at most ${AUDIENCE_LIMITS.maxValues} values in one condition.`,
    `اختر ${AUDIENCE_LIMITS.maxValues} قيم على الأكثر في الشرط الواحد.`,
  ],
  filter_and_rules: () => ["Send either rules or an old-style filter, not both. Reload the page.", "أرسل الشروط أو عامل التصفية القديم، لا كليهما. أعد تحميل الصفحة."],
  // SP-16 fix I2 (review m2): a reference chain longer than maxReferenceDepth.
  too_deep: (x) => {
    const max = num(x.max) ?? String(AUDIENCE_LIMITS.maxReferenceDepth);
    return [
      `This condition reaches more than ${max} audiences in a row. Point it at an audience with a shorter chain.`,
      `يصل هذا الشرط إلى أكثر من ${max} جماهير متتالية. اختر جمهورًا بسلسلة أقصر.`,
    ];
  },
};

export const INVALID_RULES_REASONS = Object.keys(REASON_COPY);

export function invalidReasonText(reason: string, extra: Extra, tx: Tx): string {
  const copy = REASON_COPY[reason];
  if (!copy) return tx("One of the conditions isn't valid.", "أحد الشروط غير صالح.");
  return tx(...copy(extra));
}

export const AUDIENCE_ERROR_COPY: Record<string, CopyFn> = {
  "audiences.not_found": () => ["This audience no longer exists.", "هذا الجمهور لم يعد موجودًا."],
  "audiences.reference_not_found": (x) => {
    const n = REF_NAMES[typeof x.field === "string" ? x.field : ""] ?? ["item", "العنصر"];
    return [
      `The ${n[0]} this condition uses no longer exists. Choose another one.`,
      `${n[1]} الذي يستخدمه هذا الشرط لم يعد موجودًا. اختر غيره.`,
    ];
  },
  "audiences.invalid_rules": (x) => {
    const reason = typeof x.reason === "string" ? x.reason : "";
    const copy = REASON_COPY[reason];
    return copy ? copy(x) : ["One of the conditions isn't valid.", "أحد الشروط غير صالح."];
  },
  "audiences.rule_cycle": () => [
    "This condition would make audiences refer to each other in a loop. Point it at another audience.",
    "سيجعل هذا الشرط الجماهير تشير إلى بعضها في حلقة. اختر جمهورًا آخر.",
  ],
  "audiences.rules_too_large": (x) => {
    const max = num(x.max) ?? String(AUDIENCE_LIMITS.maxConditions);
    return [
      `Too many conditions: an audience can have at most ${max}, counting the audiences it uses.`,
      `عدد الشروط كبير جدًا: الحد ${max} شرطًا، بما في ذلك شروط الجماهير التي يستخدمها.`,
    ];
  },
  "audiences.rule_too_deep": (x) => {
    const max = num(x.max) ?? String(AUDIENCE_LIMITS.maxDepth);
    return [`Groups can be nested at most ${max} levels deep.`, `يمكن تداخل المجموعات حتى ${max} مستويات فقط.`];
  },
  "audiences.not_smart": () => ["Rules can only be set on a smart audience.", "يمكن تعيين الشروط على الجمهور الذكي فقط."],
  "audiences.not_manual": () => ["People can only be added by hand to a group.", "يمكن إضافة الأشخاص يدويًا إلى المجموعات فقط."],
  "audiences.version_conflict": () => ["Someone else changed this audience.", "عدّل شخص آخر هذا الجمهور."],
  "audiences.in_use": () => [
    "Other audiences or campaigns use this audience.",
    "تستخدم جماهير أو حملات أخرى هذا الجمهور.",
  ],
  "audiences.in_use_by_campaigns": () => [
    "A scheduled or sending campaign uses this audience, so it can't be deleted now.",
    "تستخدم حملة مجدولة أو قيد الإرسال هذا الجمهور، لذا لا يمكن حذفه الآن.",
  ],
  "tags.in_use_by_audiences": () => ["Smart audiences use this tag.", "تستخدم جماهير ذكية هذا الوسم."],
  "campaigns.audience_missing": () => [
    "This campaign's audience was deleted. Choose another audience.",
    "حُذف جمهور هذه الحملة. اختر جمهورًا آخر.",
  ],
  "Segment is managed by HJZ and read-only here": () => [
    "This group is managed by HJZ and is read-only here.",
    "تُدار هذه المجموعة من HJZ وهي للقراءة فقط هنا.",
  ],
  "Tag not found": () => ["That tag no longer exists.", "هذا الوسم لم يعد موجودًا."],
  "Segment not found": () => ["This audience no longer exists.", "هذا الجمهور لم يعد موجودًا."],
};

export function audienceKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const copy = AUDIENCE_ERROR_COPY[key];
  if (!copy) return null;
  return tx(...copy(isObject(extra) ? extra : {}));
}

export const isForbidden = (e: unknown): boolean => e instanceof ApiError && e.status === 403;

/** User-facing text for any error from the audience and tag routes. */
export function audienceErrorText(e: unknown, tx: Tx): string {
  if (isForbidden(e)) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = e instanceof Error ? e.message : "";
  const body = e instanceof ApiError ? e.body : undefined;
  const key = message.split(", ")[0] ?? "";
  return audienceKeyText(key, body, tx) ?? audienceKeyText(message, body, tx) ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}

const bodyOf = (e: unknown): Extra => (e instanceof ApiError && isObject(e.body) ? e.body : {});
const keyOf = (e: unknown): string => {
  const b = bodyOf(e);
  return typeof b.message === "string" ? b.message : e instanceof Error ? e.message : "";
};

/** The rule a save or preview error points at, so the editor can highlight it; null for whole-tree errors. */
export function errorRulePath(e: unknown, tree: AudienceGroup): Path | null {
  const b = bodyOf(e);
  switch (keyOf(e)) {
    case "audiences.invalid_rules":
      return Array.isArray(b.path) && b.path.length > 0 && b.path.every((n) => typeof n === "number") ? (b.path as number[]) : null;
    case "audiences.reference_not_found":
      return typeof b.field === "string" && typeof b.id === "string" ? pathOfReference(tree, b.field, b.id) : null;
    case "audiences.rule_cycle": {
      const ids = Array.isArray(b.path) ? b.path : [];
      return typeof ids[1] === "string" ? pathOfReference(tree, "segmentId", ids[1]) : null;
    }
    default:
      return null;
  }
}

/** The newer row from a 409 `audiences.version_conflict`, else null. */
export function versionConflict(e: unknown): Segment | null {
  if (keyOf(e) !== "audiences.version_conflict") return null;
  const c = bodyOf(e).current;
  return isObject(c) ? (c as unknown as Segment) : null;
}

// ─── Safe-delete dialogs (Review Focus 2) ────────────────────────────────

/** Campaign states that block deleting their audience (server `isLiveCampaign`; launchStage is checked server-side). */
export const BLOCKING_CAMPAIGN_STATUSES = ["scheduled", "launching", "running"];

export type AudienceDeleteState =
  | { kind: "confirm" }
  | { kind: "in_use"; audiences: AudienceRefAudience[]; campaigns: AudienceRefCampaign[] }
  | { kind: "blocked"; campaigns: AudienceRefCampaign[] };

export type TagDeleteState = { kind: "plain" } | { kind: "in_use"; audiences: AudienceRefAudience[] };

const audiencesOf = (v: unknown): AudienceRefAudience[] =>
  Array.isArray(v)
    ? v.filter(isObject).map((a) => ({ id: String(a.id ?? ""), name: String(a.name ?? ""), nameAr: typeof a.nameAr === "string" ? a.nameAr : null }))
    : [];
const campaignsOf = (v: unknown): AudienceRefCampaign[] =>
  Array.isArray(v) ? v.filter(isObject).map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), status: String(c.status ?? "") })) : [];

/** Pre-warn from `GET /segments/:id` references, before the DELETE is sent. */
export function audienceDeleteStateFromRefs(refs: { audiences: AudienceRefAudience[]; campaigns: AudienceRefCampaign[] }): AudienceDeleteState {
  const blocking = refs.campaigns.filter((c) => BLOCKING_CAMPAIGN_STATUSES.includes(c.status));
  if (blocking.length) return { kind: "blocked", campaigns: blocking };
  if (refs.audiences.length || refs.campaigns.length) return { kind: "in_use", audiences: refs.audiences, campaigns: refs.campaigns };
  return { kind: "confirm" };
}

/** A DELETE /segments/:id 409 as a dialog state; null for any other error. */
export function audienceDeleteStateFromError(e: unknown): AudienceDeleteState | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = bodyOf(e);
  if (keyOf(e) === "audiences.in_use_by_campaigns") return { kind: "blocked", campaigns: campaignsOf(b.campaigns) };
  if (keyOf(e) === "audiences.in_use") return { kind: "in_use", audiences: audiencesOf(b.audiences), campaigns: campaignsOf(b.campaigns) };
  return null;
}

export function tagDeleteStateFromRefs(refs: TagReferences): TagDeleteState {
  return refs.audiences.length ? { kind: "in_use", audiences: refs.audiences } : { kind: "plain" };
}

/** A DELETE /tags/:id 409 (a reference appeared after the check) as a dialog state; null otherwise. */
export function tagDeleteStateFromError(e: unknown): TagDeleteState | null {
  if (!(e instanceof ApiError) || e.status !== 409 || keyOf(e) !== "tags.in_use_by_audiences") return null;
  return { kind: "in_use", audiences: audiencesOf(bodyOf(e).audiences) };
}
