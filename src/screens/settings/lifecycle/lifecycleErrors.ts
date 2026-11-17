import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { isWhatsAppNotConnected, whatsAppGateText } from "@/components/whatsAppGateCopy";
import type { Tx } from "@/lib/tx";
import { templateErrorText } from "@/screens/templates/templateErrors";

/**
 * SP-24 copy for the backend's lifecycle error keys and
 * `workflows.system_locked` (backend/src/lifecycle/lifecycle-errors.ts;
 * lifecycleErrors.test.ts pins the key list).
 */
type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const LANG_WORD: Record<string, [string, string]> = { ar: ["Arabic", "العربية"], en: ["English", "الإنجليزية"] };
const langWord = (v: unknown): [string, string] =>
  typeof v === "string" && LANG_WORD[v] ? LANG_WORD[v] : ["one language", "إحدى اللغتين"];

/** "1 hour" … "1 week" for an offset bound in minutes (Latin digits). */
function span(min: number): [string, string] {
  if (min % 10080 === 0) return min === 10080 ? ["1 week", "أسبوع"] : [`${min / 10080} weeks`, `${min / 10080} أسابيع`];
  if (min % 1440 === 0) return min === 1440 ? ["1 day", "يوم"] : [`${min / 1440} days`, `${min / 1440} أيام`];
  if (min % 60 === 0) return min === 60 ? ["1 hour", "ساعة"] : [`${min / 60} hours`, `${min / 60} ساعات`];
  return [`${min} minutes`, `${min} دقيقة`];
}

export const LIFECYCLE_ERROR_COPY: Record<string, CopyFn> = {
  "lifecycle.invalid_recipient": () => [
    "Choose who gets this message. For specific members, pick at least one active member.",
    "اختر من يستلم هذه الرسالة. عند اختيار أعضاء محددين اختر عضوًا نشطًا واحدًا على الأقل.",
  ],
  "lifecycle.invalid_offset": (x) => {
    const min = typeof x.min === "number" ? x.min : 60;
    const max = typeof x.max === "number" ? x.max : 10080;
    const [a, b] = [span(min), span(max)];
    return [`Choose a reminder between ${a[0]} and ${b[0]} before the booking.`, `اختر تذكيرًا بين ${a[1]} و${b[1]} قبل الحجز.`];
  },
  "lifecycle.unknown_key": () => ["This automatic message doesn't exist.", "هذه الرسالة التلقائية غير موجودة."],
  "lifecycle.not_set_up": () => ["Set up this message before turning it on.", "أعِدّ هذه الرسالة قبل تفعيلها."],
  "lifecycle.template_rejected": (x) => {
    const [en, ar] = langWord(x.language);
    const reason = typeof x.reason === "string" && x.reason.trim() ? x.reason.trim() : null;
    return reason
      ? [`WhatsApp rejected the ${en} message (${reason}). Fix and resubmit it first.`, `رفض واتساب الرسالة ${ar} (${reason}). صحّحها وأعد إرسالها أولًا.`]
      : [`WhatsApp rejected the ${en} message. Fix and resubmit it first.`, `رفض واتساب الرسالة ${ar}. صحّحها وأعد إرسالها أولًا.`];
  },
  "lifecycle.template_missing": (x) => {
    const [en, ar] = langWord(x.language);
    return [`The ${en} message is missing. Set up this message again.`, `الرسالة ${ar} غير موجودة. أعد إعداد هذه الرسالة.`];
  },
  "lifecycle.whatsapp_not_connected": () => [
    "WhatsApp isn't connected. Connect a number in Channels to turn on automatic messages.",
    "واتساب غير متصل. اربط رقمًا من القنوات لتفعيل الرسائل التلقائية.",
  ],
  "workflows.system_locked": () => [
    "This workflow is managed in Automatic messages. Change it there.",
    "تُدار هذه الأتمتة من الرسائل التلقائية. عدّلها من هناك.",
  ],
};

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

/** Copy for a lifecycle key; null when unknown. */
export function lifecycleKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const fn = LIFECYCLE_ERROR_COPY[key];
  if (!fn) return null;
  const [en, ar] = fn(isObject(extra) ? extra : {});
  return tx(en, ar);
}

export const isForbidden = (e: unknown) => e instanceof ApiError && e.status === 403;
export const isSystemLocked = (e: unknown) => e instanceof ApiError && e.message === "workflows.system_locked";

/** User-facing text for any error from the lifecycle routes (and the template PATCH in the edit drawer). */
export function lifecycleErrorText(err: unknown, tx: Tx): string {
  if (isForbidden(err)) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  if (err instanceof ApiError) {
    const own = lifecycleKeyText(err.message, err.body, tx);
    if (own) return own;
    if (isWhatsAppNotConnected(err)) return whatsAppGateText(tx);
    return templateErrorText(err, tx);
  }
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}
