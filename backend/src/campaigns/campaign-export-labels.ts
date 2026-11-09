import { isShortTitle, PROVIDER_UNKNOWN } from "./tracking/failure-codes";
import type { RecipientStatus } from "./tracking/recipient-status";
import type { ExportLang } from "./campaign-report.dto";

/**
 * SP-12 CSV copy. The detail page has its own mirror
 * (src/screens/campaigns/failureCodes.ts, Task 3); keep the two in step.
 */

export const EXPORT_HEADERS: Record<ExportLang, string[]> = {
  en: [
    "Name",
    "Phone",
    "Status",
    "Sent at",
    "Delivered at",
    "Read at",
    "Replied at",
    "Reply",
    "Button",
    "Failure code",
    "Failure reason",
    "Sending number",
  ],
  ar: [
    "الاسم",
    "الهاتف",
    "الحالة",
    "وقت الإرسال",
    "وقت التسليم",
    "وقت القراءة",
    "وقت الرد",
    "الرد",
    "الزر",
    "رمز الفشل",
    "سبب الفشل",
    "رقم الإرسال",
  ],
};

export const STATUS_LABELS: Record<RecipientStatus, [en: string, ar: string]> = {
  queued: ["Queued", "في الانتظار"],
  sent: ["Sent", "أُرسلت"],
  delivered: ["Delivered", "وصلت"],
  read: ["Read", "قُرئت"],
  replied: ["Replied", "ردّ"],
  failed: ["Failed", "فشلت"],
  skipped: ["Skipped", "مُستبعد"],
};

/** Copy per code. Meta meanings follow the plan's table; check them against Meta's error-code reference. */
export const FAILURE_LABELS: Record<string, [en: string, ar: string]> = {
  "skip:opted_out": ["Opted out of marketing", "ألغى الاشتراك في الرسائل التسويقية"],
  "skip:no_phone": ["No usable phone number", "لا يوجد رقم هاتف صالح"],
  "provider:unknown": ["Provider error", "خطأ من مزوّد الخدمة"],
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

const pick = (pair: [string, string], lang: ExportLang) => (lang === "ar" ? pair[1] : pair[0]);

export function statusLabel(status: string, lang: ExportLang): string {
  const pair = STATUS_LABELS[status as RecipientStatus];
  return pair ? pick(pair, lang) : status;
}

/**
 * The localized reason for a failure code. Unknown `meta:<n>` reads
 * "WhatsApp error <n>"; a short provider text is appended to codes without
 * their own copy. The raw provider text is never used otherwise.
 */
export function failureLabel(code: string | null, reason: string | null, lang: ExportLang): string {
  if (!code) return "";
  const known = FAILURE_LABELS[code];
  if (known && code !== PROVIDER_UNKNOWN) return pick(known, lang);
  const short = isShortTitle(reason) ? reason!.trim() : null;
  const meta = /^meta:(\d+)$/.exec(code);
  const base = known
    ? pick(known, lang)
    : meta
      ? lang === "ar"
        ? `خطأ واتساب ${meta[1]}`
        : `WhatsApp error ${meta[1]}`
      : code;
  return short ? `${base}: ${short}` : base;
}
