import { ApiError } from "@/api/client";
import { STREAM_LOST } from "@/api/eventStream";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { ATTACH_DOC_MAX_BYTES, FEEDBACK_MAX, MAX_REFS, MESSAGE_MAX, ATTACH_MAX_PER_MESSAGE } from "./copilotConstants";

/**
 * SP-18 copy for every copilot error key: the HTTP keys
 * (backend/src/copilot/copilot-errors.ts COPILOT_ERROR_STATUS), the stream
 * error codes (STREAM_ERROR_CODES), the client's own `copilot.stream_lost`,
 * and the card error keys (`errorKey`). copilotErrors.test.ts pins the list
 * to the backend file. Numbers use Latin digits in both languages.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d).toLocaleString("en-US");
const mb = (v: unknown, d: number) => `${Math.round((typeof v === "number" && v > 0 ? v : d) / (1024 * 1024))} MB`;
const wait = (x: Extra): [string, string] => {
  const s = typeof x.retryAfterSeconds === "number" && x.retryAfterSeconds > 0 ? x.retryAfterSeconds : 60;
  if (s < 3600) {
    const m = Math.max(1, Math.ceil(s / 60));
    return [`${m} minute${m === 1 ? "" : "s"}`, `${m} دقيقة`];
  }
  const h = Math.ceil(s / 3600);
  return [`${h} hour${h === 1 ? "" : "s"}`, `${h} ساعة`];
};
const STATUS: Record<string, [string, string]> = {
  EXECUTED: ["already done", "نُفّذت بالفعل"],
  REJECTED: ["already declined or refused", "رُفضت بالفعل"],
  EXPIRED: ["expired", "انتهت صلاحيتها"],
  FAILED: ["already tried and failed", "جُرّبت وفشلت"],
  EXECUTING: ["being applied", "قيد التنفيذ"],
};

export const COPILOT_ERROR_COPY: Record<string, CopyFn> = {
  "copilot.message_invalid": (x) => [`Write a message of up to ${n(x.max, MESSAGE_MAX)} characters.`, `اكتب رسالة لا تتجاوز ${n(x.max, MESSAGE_MAX)} حرف.`],
  "copilot.too_many_refs": (x) => [`Reference up to ${n(x.max, MAX_REFS)} records in one message.`, `يمكنك الإشارة إلى ${n(x.max, MAX_REFS)} سجلات كحد أقصى في الرسالة الواحدة.`],
  "copilot.too_many_attachments": (x) => [`Attach up to ${n(x.max, ATTACH_MAX_PER_MESSAGE)} files to one message.`, `يمكنك إرفاق ${n(x.max, ATTACH_MAX_PER_MESSAGE)} ملفات كحد أقصى في الرسالة الواحدة.`],
  "copilot.attachment_type": () => ["Attach a PDF, CSV, Excel (.xlsx), text file or a JPEG, PNG or WebP image.", "أرفق ملف PDF أو CSV أو Excel (.xlsx) أو ملفًا نصيًا أو صورة JPEG أو PNG أو WebP."],
  "copilot.attachment_too_large": (x) => [`This file is too large (up to ${mb(x.maxBytes, ATTACH_DOC_MAX_BYTES)}).`, `هذا الملف كبير جدًا (الحد ${mb(x.maxBytes, ATTACH_DOC_MAX_BYTES)}).`],
  "copilot.page_context_invalid": () => ["This page's record isn't available to you any more. Reload the page.", "سجل هذه الصفحة لم يعد متاحًا لك. أعد تحميل الصفحة."],
  "copilot.feedback_too_long": (x) => [`Keep the note under ${n(x.max, FEEDBACK_MAX)} characters.`, `اجعل الملاحظة أقل من ${n(x.max, FEEDBACK_MAX)} حرف.`],
  "copilot.ref_not_permitted": (x) => {
    const i = typeof x.index === "number" ? x.index + 1 : null;
    return i
      ? [`You can't open referenced record ${n(i, 1)}. Remove it and send again.`, `لا يمكنك فتح السجل المُشار إليه رقم ${n(i, 1)}. أزله وأرسل مرة أخرى.`]
      : ["You can't open one of the referenced records. Remove it and send again.", "لا يمكنك فتح أحد السجلات المُشار إليها. أزله وأرسل مرة أخرى."];
  },
  "copilot.permission_revoked": () => ["Your permission changed, so nothing was done.", "تغيّرت صلاحياتك، لذلك لم يُنفَّذ شيء."],
  "copilot.not_found": () => ["This chat or item is no longer available.", "هذه المحادثة أو العنصر لم يعد متاحًا."],
  "copilot.turn_running": () => ["Kewy is still answering in this chat. Wait for the answer, then send again.", "كيوي لا يزال يجيب في هذه المحادثة. انتظر الإجابة ثم أرسل مرة أخرى."],
  "copilot.action_closed": (x) => {
    const s = typeof x.status === "string" ? STATUS[x.status] : undefined;
    return s ? [`This change was ${s[0]}.`, `هذا التغيير ${s[1]}.`] : ["This change was already decided.", "تم البت في هذا التغيير بالفعل."];
  },
  "copilot.card_outdated": () => ["The record changed since this card was made, so nothing was done. Ask again for a fresh card.", "تغيّر السجل منذ إنشاء هذه البطاقة، لذلك لم يُنفَّذ شيء. اطلب بطاقة جديدة."],
  "copilot.action_expired": () => ["This card expired, so nothing was done. Ask again if you still want it.", "انتهت صلاحية هذه البطاقة، لذلك لم يُنفَّذ شيء. اطلبها مجددًا إن كنت لا تزال تريدها."],
  "copilot.rate": (x) => {
    const [e, a] = wait(x);
    return [`You're sending messages quickly. Try again in ${e}.`, `أنت ترسل الرسائل بسرعة. حاول مجددًا بعد ${a}.`];
  },
  "copilot.daily_limit": (x) => {
    const [e, a] = wait(x);
    return [`Your workspace reached today's limit for Kewy. Try again in ${e}.`, `وصلت مساحة العمل إلى حد اليوم لكيوي. حاول مجددًا بعد ${a}.`];
  },
  "copilot.unavailable": () => ["Kewy isn't available right now.", "كيوي غير متاح الآن."],
  // Stream error codes.
  "copilot.ai_failed": () => ["Kewy couldn't answer this time. Try again.", "تعذّر على كيوي الإجابة هذه المرة. حاول مرة أخرى."],
  "copilot.refused": () => ["Kewy can't help with that request.", "لا يستطيع كيوي المساعدة في هذا الطلب."],
  "copilot.limit": () => ["That took too many steps. Try a narrower question.", "استغرق ذلك خطوات كثيرة. جرّب سؤالًا أدق."],
  "copilot.timeout": () => ["That took too long. Try again or ask something narrower.", "استغرق ذلك وقتًا طويلًا. حاول مرة أخرى أو اسأل سؤالًا أدق."],
  "copilot.attachment_unavailable": () => ["An attached image can't be loaded right now. Try again, or start a new chat.", "تعذّر تحميل صورة مرفقة الآن. حاول مرة أخرى أو ابدأ محادثة جديدة."],
  // The client's own: the stream was cut (the answer may still arrive).
  [STREAM_LOST]: () => ["The connection dropped. Kewy's answer will appear here when it's ready.", "انقطع الاتصال. ستظهر إجابة كيوي هنا عندما تجهز."],
  // Card error keys (errorKey on a FAILED card).
  "copilot.action_unknown": () => ["Status unknown — check the record.", "الحالة غير معروفة — تحقّق من السجل."],
  "copilot.action_failed": () => ["This change couldn't be made. Nothing was saved.", "تعذّر تنفيذ هذا التغيير. لم يُحفظ شيء."],
};

/** Copy for a key (unknown keys fall back to a generic line). */
export function copilotKeyText(key: string, tx: Tx, extra: Extra = {}): string {
  const fn = COPILOT_ERROR_COPY[key];
  if (fn) {
    const [en, ar] = fn(extra);
    return tx(en, ar);
  }
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}

/** Copy for a thrown error: an ApiError's key (body.message) with its extras. */
export function copilotErrorText(err: unknown, tx: Tx): string {
  if (err instanceof ApiError) {
    const body = (err.body && typeof err.body === "object" ? err.body : {}) as Extra;
    const key = typeof body.message === "string" ? body.message : err.message;
    if (COPILOT_ERROR_COPY[key]) return copilotKeyText(key, tx, body);
    if (err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  }
  return copilotKeyText("", tx);
}

/** Stream codes the member can retry by sending again. */
export const RETRYABLE_STREAM_CODES: ReadonlySet<string> = new Set(["copilot.ai_failed", "copilot.timeout", "copilot.attachment_unavailable", STREAM_LOST]);
