import type { Tx } from "@/lib/tx";
import { isolateLtr } from "./senderModel";
import { fieldLabelOf, type CustomLabels } from "./varMap";

/**
 * SP-12 failure-reason copy. Mirror of the backend CSV copy in
 * backend/src/campaigns/campaign-export-labels.ts (FAILURE_LABELS); keep the
 * two in step. Pure, so it is unit-tested for completeness.
 */
export const FAILURE_LABELS: Record<string, [en: string, ar: string]> = {
  "skip:opted_out": ["Opted out of marketing", "ألغى الاشتراك في الرسائل التسويقية"],
  "skip:no_phone": ["No usable phone number", "لا يوجد رقم هاتف صالح"],
  "provider:unknown": ["Provider error", "خطأ من مزوّد الخدمة"],
  // SP-13: a direct send whose outcome was never confirmed within 23 h (never re-sent).
  "launch:unconfirmed": ["Send not confirmed; not retried", "لم يتأكد الإرسال؛ لم تتم إعادة المحاولة"],
  "meta:131026": ["Message undeliverable", "تعذر توصيل الرسالة"],
  "meta:131047": ["More than 24 hours since the customer replied", "مرّ أكثر من 24 ساعة على آخر رد من العميل"],
  "meta:131049": ["Held by Meta (per-user marketing limit)", "أوقفتها ميتا (حد الرسائل التسويقية لكل مستخدم)"],
  "meta:131050": ["The customer stopped marketing messages", "أوقف العميل استلام الرسائل التسويقية"],
  "meta:131056": ["Too many messages to this number", "رسائل كثيرة جدًا إلى هذا الرقم"],
  "meta:131048": ["Spam rate limit reached", "تم بلوغ حد الرسائل المزعجة"],
  "meta:131042": ["Business payment issue", "مشكلة في الدفع لحساب الأعمال"],
  "meta:131031": ["Business account locked", "حساب الأعمال مقفل"],
  "meta:131051": ["Unsupported message type", "نوع رسالة غير مدعوم"],
  "meta:131052": ["Media download failed", "تعذر تنزيل الوسائط"],
  "meta:131053": ["Media upload failed", "تعذر رفع الوسائط"],
  "meta:132000": ["Template variable count mismatch", "عدد متغيرات القالب غير مطابق"],
  "meta:132001": ["Template does not exist", "القالب غير موجود"],
  "meta:132015": ["Template paused", "القالب متوقف مؤقتًا"],
  "meta:132016": ["Template disabled", "القالب معطّل"],
  "meta:130472": ["Number is in a Meta experiment", "الرقم ضمن تجربة لدى ميتا"],
  "meta:131000": ["Something went wrong", "حدث خطأ ما"],
  "meta:368": ["Temporarily blocked for policy violations", "محظور مؤقتًا بسبب مخالفة السياسات"],
};

const PROVIDER_UNKNOWN = "provider:unknown";
const SHORT_TITLE_MAX = 120;

/** Tkana's rule (backend tracking/failure-codes.ts): one line, at most 120 characters, no `{`. */
export function isShortTitle(s: string | null | undefined): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 0 && t.length <= SHORT_TITLE_MAX && !/[\r\n]/.test(t) && !t.includes("{");
}

/**
 * The localized reason for a failure code. Unknown `meta:<n>` reads
 * "WhatsApp error <n>"; codes without their own copy (and provider:unknown)
 * get the short provider title appended. Raw provider text is never shown
 * otherwise.
 */
export function failureLabel(code: string | null, title: string | null, tx: Tx, customLabels?: CustomLabels): string {
  if (!code) return "";
  const missing = /^skip:missing_value:(field|custom)\.(.+)$/.exec(code);
  if (missing) return missingValueLabel(missing[1] as "field" | "custom", missing[2]!, tx, customLabels);
  const known = FAILURE_LABELS[code];
  if (known && code !== PROVIDER_UNKNOWN) return tx(known[0], known[1]);
  const short = isShortTitle(title) ? title!.trim() : null;
  const meta = /^meta:(\d+)$/.exec(code);
  const skip = /^skip:(.+)$/.exec(code);
  const base = known
    ? tx(known[0], known[1])
    : meta
      ? tx(`WhatsApp error ${meta[1]}`, `خطأ واتساب ${meta[1]}`)
      : skip
        ? tx(`Left out (${skip[1]})`, `مُستبعد (${skip[1]})`)
        : code;
  return short ? `${base}: ${short}` : base;
}

/** Failed or skipped rows whose code was never recorded (`unrecorded`). */
export const unrecordedLabel = (tx: Tx): string => tx("Reason not recorded", "السبب غير مسجّل");

/**
 * SP-13 `skip:missing_value:<source>.<key>`: "No value for <label>" (backend
 * campaign-export-labels.ts `missingValueLabel`, word for word). Custom
 * labels come from the workspace's field list; an unknown key shows the raw
 * key, isolated left to right.
 */
export function missingValueLabel(source: "field" | "custom", key: string, tx: Tx, customLabels?: CustomLabels): string {
  const l = fieldLabelOf(source, key, customLabels);
  const en = l.known ? l.label : isolateLtr(key);
  const ar = l.known ? l.labelAr : isolateLtr(key);
  return tx(`No value for ${en}`, `لا توجد قيمة لـ ${ar}`);
}
