import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

export const LEGACY_EDITED_COPY: [string, string] = [
  "Your agent's instructions still contain an older edited version of this skill's text. Remove it from the agent prompt, then try again.",
  "لا تزال تعليمات وكيلك تحتوي على نسخة قديمة معدّلة من نص هذه المهارة. احذفها من تعليمات الوكيل ثم حاول مرة أخرى.",
];

/**
 * Copy for every SP-22 error key (backend/src/skills/skill-errors.ts: the
 * route keys and the tool keys; skillErrors.test.ts pins the list).
 */
export const SKILL_ERROR_COPY: Record<string, [string, string]> = {
  "skills.invalid_config": ["Some settings are not valid. Check the highlighted fields.", "بعض الإعدادات غير صالحة. راجع الحقول المحددة."],
  "skills.unknown": ["This skill does not exist.", "هذه المهارة غير موجودة."],
  "skills.not_installed": ["This skill is not installed.", "هذه المهارة غير مثبتة."],
  "skills.already_installed": ["This skill is already installed.", "هذه المهارة مثبتة بالفعل."],
  "skills.agent_not_connected": [
    "Connect this workspace to a Kewy AI agent first.",
    "اربط مساحة العمل هذه بوكيل كيوي الذكاء أولًا.",
  ],
  "skills.connector_required": ["Connect the required app first.", "اربط التطبيق المطلوب أولًا."],
  "skills.version_conflict": ["Someone else changed this skill", "عدّل شخص آخر هذه المهارة"],
  "skills.config_required": ["Fill in the required settings first.", "أكمل الإعدادات المطلوبة أولًا."],
  "skills.up_to_date": ["This skill is already up to date.", "هذه المهارة محدّثة بالفعل."],
  "skills.legacy_edited": LEGACY_EDITED_COPY,
  // Tool error keys (what the agent's tools report; shown in usage details).
  "skills.tag_not_allowed": ["The agent tried a tag that is not allowed.", "حاول الوكيل إضافة وسم غير مسموح به."],
  "tickets.no_support_pipeline": ["There is no support pipeline to open tickets in.", "لا توجد مسار دعم لفتح التذاكر فيه."],
  "tickets.too_many_open": ["This customer already has 3 open support tickets.", "لدى هذا العميل 3 تذاكر دعم مفتوحة بالفعل."],
};

export const SKILL_ERROR_KEYS = Object.keys(SKILL_ERROR_COPY);

/** Field-level codes of `skills.invalid_config {errors: [{key, code}]}`. */
export const FIELD_ERROR_COPY: Record<string, [string, string]> = {
  unknown_key: ["Unknown setting.", "إعداد غير معروف."],
  wrong_type: ["Wrong kind of value.", "نوع القيمة غير صحيح."],
  not_an_option: ["Choose one of the options.", "اختر أحد الخيارات."],
  below_min: ["Too small.", "القيمة صغيرة جدًا."],
  above_max: ["Too large or too many.", "القيمة كبيرة جدًا أو العدد كبير جدًا."],
  too_long: ["Too long.", "النص طويل جدًا."],
  required: ["Required.", "مطلوب."],
  too_large: ["The settings are too large.", "الإعدادات كبيرة جدًا."],
  unsafe_text: ["Use letters, digits, spaces, - _ and . only.", "استخدم الحروف والأرقام والمسافات و - _ . فقط."],
};

function bodyOf(e: unknown): Record<string, unknown> | null {
  return e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : null;
}

export function skillErrorKey(e: unknown): string | null {
  const m = bodyOf(e)?.message ?? (e instanceof Error ? e.message : null);
  return typeof m === "string" && SKILL_ERROR_COPY[m] ? m : null;
}

/** `{fieldKey: message}` from a `skills.invalid_config` error. */
export function fieldErrorsOf(e: unknown, tx: Tx): Record<string, string> {
  const errors = bodyOf(e)?.errors;
  const out: Record<string, string> = {};
  if (!Array.isArray(errors)) return out;
  for (const err of errors) {
    if (!err || typeof err !== "object") continue;
    const { key, code } = err as { key?: unknown; code?: unknown };
    const copy = FIELD_ERROR_COPY[String(code)] ?? FIELD_ERROR_COPY.wrong_type;
    out[typeof key === "string" ? key : ""] = tx(copy[0], copy[1]);
  }
  return out;
}

export function skillErrorText(e: unknown, tx: Tx): string {
  const key = skillErrorKey(e);
  if (key === "skills.connector_required") {
    const provider = String(bodyOf(e)?.provider ?? "");
    if (provider) return tx(`Connect ${provider} first.`, `اربط ${provider} أولًا.`);
  }
  if (key) {
    const [en, ar] = SKILL_ERROR_COPY[key]!;
    return tx(en, ar);
  }
  if (e instanceof ApiError && e.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const msg = e instanceof Error ? e.message : "";
  return msg || tx("Something went wrong.", "حدث خطأ ما.");
}
