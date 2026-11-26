import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { FAQ_ANSWER_MAX, FAQ_MAX, FAQ_QUESTION_MAX, GUIDELINES_MAX, KB_BATCH_MAX, KB_FILE_MAX_BYTES, KNOWLEDGE_CONTENT_MAX, WEBSITE_MAX_SOURCES } from "./knowledgeConstants";
import { columnReportText, rowErrorsSummary } from "./typedErrors";

/**
 * SP-21 copy for the backend's knowledge error keys
 * (backend/src/knowledge-sources/knowledge-errors.ts): the thrown keys
 * (KNOWLEDGE_ERROR_STATUS) and the keys stored on a source
 * (KNOWLEDGE_SOURCE_ERRORS). The key is the error's `message`; extras ride in
 * the body. knowledgeErrors.test.ts pins the key lists to the backend file.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const n = (v: number) => v.toLocaleString("en-US");
const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const fileOf = (x: Extra) => (typeof x.fileName === "string" && x.fileName ? x.fileName : null);

export const KNOWLEDGE_ERROR_COPY: Record<string, CopyFn> = {
  // Thrown (400 / 404 / 409 / 413)
  "knowledge.content_invalid": () => [
    "This content has formatting the assistant can't use. Keep to headings, lists, bold, italic and https links.",
    "يحتوي هذا المحتوى على تنسيق لا يستطيع المساعد استخدامه. استخدم العناوين والقوائم والخط العريض والمائل وروابط https فقط.",
  ],
  "knowledge.content_too_long": (x) => [
    `The content is too long (up to ${n(num(x.max, KNOWLEDGE_CONTENT_MAX))} characters).`,
    `المحتوى طويل جدًا (حتى ${n(num(x.max, KNOWLEDGE_CONTENT_MAX))} حرف).`,
  ],
  "knowledge.faq_duplicate": () => ["This question is already in your FAQs.", "هذا السؤال موجود بالفعل في الأسئلة الشائعة."],
  "knowledge.faq_too_long": (x) =>
    x.field === "answer"
      ? [`The answer is too long (up to ${n(num(x.max, FAQ_ANSWER_MAX))} characters).`, `الإجابة طويلة جدًا (حتى ${n(num(x.max, FAQ_ANSWER_MAX))} حرف).`]
      : [`The question is too long (up to ${n(num(x.max, FAQ_QUESTION_MAX))} characters).`, `السؤال طويل جدًا (حتى ${n(num(x.max, FAQ_QUESTION_MAX))} حرف).`],
  "knowledge.faq_limit": (x) => [
    `You've reached the limit of ${n(num(x.limit, FAQ_MAX))} FAQs.`,
    `وصلت إلى الحد الأقصى وهو ${n(num(x.limit, FAQ_MAX))} سؤالًا.`,
  ],
  "knowledge.guidelines_too_long": (x) => [
    `Guidelines are too long (up to ${n(num(x.max, GUIDELINES_MAX))} characters).`,
    `الإرشادات طويلة جدًا (حتى ${n(num(x.max, GUIDELINES_MAX))} حرف).`,
  ],
  "knowledge.reorder_mismatch": () => [
    "The FAQ list changed while you were reordering. Reload and try again.",
    "تغيّرت قائمة الأسئلة أثناء إعادة الترتيب. أعد التحميل وحاول مجددًا.",
  ],
  "knowledge.file_type": (x) => {
    const f = fileOf(x);
    return f
      ? [`${f}: upload a PDF, Excel (.xlsx), CSV or JPEG, PNG or WebP image. Save ODS files as .xlsx first.`, `${f}: ارفع ملف PDF أو Excel (‎.xlsx) أو CSV أو صورة JPEG أو PNG أو WebP. احفظ ملفات ODS بصيغة ‎.xlsx أولًا.`]
      : ["Upload a PDF, Excel (.xlsx), CSV or JPEG, PNG or WebP image. Save ODS files as .xlsx first.", "ارفع ملف PDF أو Excel (‎.xlsx) أو CSV أو صورة JPEG أو PNG أو WebP. احفظ ملفات ODS بصيغة ‎.xlsx أولًا."];
  },
  "knowledge.file_too_large": (x) => {
    const max = mb(num(x.maxBytes, KB_FILE_MAX_BYTES));
    const f = fileOf(x);
    return f
      ? [`${f} is larger than ${max}. Nothing was uploaded.`, `الملف ${f} أكبر من ${max}. لم يُرفع أي ملف.`]
      : [`Each file must be ${max} or smaller. Nothing was uploaded.`, `يجب ألا يتجاوز حجم كل ملف ${max}. لم يُرفع أي ملف.`];
  },
  "knowledge.batch_too_large": (x) => [
    `Upload at most ${num(x.max, KB_BATCH_MAX)} files at a time. Nothing was uploaded.`,
    `ارفع ${num(x.max, KB_BATCH_MAX)} ملفات كحد أقصى في كل مرة. لم يُرفع أي ملف.`,
  ],
  "knowledge.template_columns": (x) => columnReportText(x),
  "knowledge.typed_rows": (x) => rowErrorsSummary(x),
  "knowledge.url_invalid": () => ["Enter a website address, such as https://example.com", "أدخل عنوان موقع مثل https://example.com"],
  "knowledge.url_blocked": () => [
    "That address can't be added. Use a public website, not a local or IP address.",
    "لا يمكن إضافة هذا العنوان. استخدم موقعًا عامًا وليس عنوانًا محليًا أو عنوان IP.",
  ],
  "knowledge.not_https": () => [
    "This site doesn't answer over https. Only secure (https) websites can be added.",
    "هذا الموقع لا يعمل عبر https. يمكن إضافة المواقع الآمنة (https) فقط.",
  ],
  "knowledge.website_limit": (x) => [
    `You can add up to ${num(x.limit, WEBSITE_MAX_SOURCES)} websites.`,
    `يمكنك إضافة ${num(x.limit, WEBSITE_MAX_SOURCES)} مواقع كحد أقصى.`,
  ],
  "knowledge.not_found": () => ["This knowledge source no longer exists.", "مصدر المعرفة هذا لم يعد موجودًا."],
  "knowledge.agent_off": () => [
    "Turn on your AI agent first. Its knowledge is kept with the agent.",
    "شغّل وكيل الذكاء الاصطناعي أولًا. تُحفظ المعرفة مع الوكيل.",
  ],
  "knowledge.storage_unavailable": () => [
    "Files can't be stored right now. Try again later.",
    "لا يمكن حفظ الملفات الآن. حاول مرة أخرى لاحقًا.",
  ],
  "knowledge.template_invalid": () => ["This spreadsheet type isn't set up correctly.", "نوع جدول البيانات هذا غير مُعدّ بشكل صحيح."],
  "knowledge.agent_unknown": () => ["This agent no longer exists.", "هذا الوكيل لم يعد موجودًا."],
  "knowledge.version_conflict": () => [
    "Someone else saved this. Reload to see their version.",
    "حفظ شخص آخر هذا المحتوى. أعد التحميل لرؤية نسخته.",
  ],
  "knowledge.website_exists": () => ["This website is already in your knowledge.", "هذا الموقع موجود بالفعل في المعرفة."],
  "knowledge.syncing": () => ["This website is syncing right now. Try again when it finishes.", "تجري مزامنة هذا الموقع الآن. حاول مجددًا عند انتهائها."],
  "knowledge.cooldown": (x) => {
    const mins = Math.max(1, Math.ceil(num(x.retryAfterSeconds, 3600) / 60));
    return [`You can refresh again in ${mins} min.`, `يمكنك التحديث مجددًا بعد ${mins} دقيقة.`];
  },

  // Stored on a source (status failed / page error)
  "knowledge.unreadable": () => ["We couldn't read this file. Check that it opens, then upload it again.", "تعذّرت قراءة هذا الملف. تأكد من أنه يفتح ثم ارفعه مجددًا."],
  "knowledge.empty": () => ["We found no text in this source.", "لم نعثر على أي نص في هذا المصدر."],
  "knowledge.processing_stalled": () => ["Processing took too long and stopped. Try again.", "استغرقت المعالجة وقتًا طويلًا وتوقفت. حاول مجددًا."],
  "knowledge.ai_unavailable": () => [
    "Reading scanned PDFs and images isn't available right now. Upload a PDF with selectable text instead.",
    "قراءة ملفات PDF الممسوحة والصور غير متاحة الآن. ارفع ملف PDF بنص قابل للتحديد بدلًا من ذلك.",
  ],
  "knowledge.ai_failed": () => ["We couldn't read the text in this file. Try again later.", "تعذّرت قراءة النص في هذا الملف. حاول لاحقًا."],
  "knowledge.pdf_too_long": () => ["This scanned PDF is too long to read. Split it into smaller files.", "ملف PDF الممسوح هذا طويل جدًا. قسّمه إلى ملفات أصغر."],
  "knowledge.site_unreachable": () => ["We couldn't reach this website or read its robots.txt.", "تعذّر الوصول إلى هذا الموقع أو قراءة ملف robots.txt الخاص به."],
  "knowledge.no_pages": () => ["We couldn't read any page of this website.", "تعذّرت قراءة أي صفحة من هذا الموقع."],
  "knowledge.page_no_text": () => [
    "This website's pages show their text only in a browser (JavaScript), so we couldn't read it. Add the content as a file or text instead.",
    "تعرض صفحات هذا الموقع نصها داخل المتصفح فقط (JavaScript)، لذا تعذّرت قراءته. أضف المحتوى كملف أو نص بدلًا من ذلك.",
  ],
};

/** The key of an ApiError body (`message`), or "". */
export function errorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "";
  const body = err.body as Extra | undefined;
  return typeof body?.message === "string" ? body.message : err.message;
}

export function errorExtra(err: unknown): Extra {
  return err instanceof ApiError && typeof err.body === "object" && err.body !== null ? (err.body as Extra) : {};
}

/** Copy for a key (a stored source error, or a thrown key with its extras); null when unknown. */
export function knowledgeKeyText(key: string | null | undefined, tx: Tx, extra: Extra = {}): string | null {
  const c = key ? KNOWLEDGE_ERROR_COPY[key] : undefined;
  if (!c) return null;
  const [en, ar] = c(extra);
  return tx(en, ar);
}

/** Localized text for anything a knowledge call can throw; a 403 is the shared no-permission copy. */
export function knowledgeErrorText(err: unknown, tx: Tx, fallback?: string): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const known = knowledgeKeyText(errorKey(err), tx, errorExtra(err));
  if (known) return known;
  return fallback ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}

/** The `current` row of a 409 `knowledge.version_conflict`, or null. */
export function conflictCurrent<T>(err: unknown): T | null {
  if (errorKey(err) !== "knowledge.version_conflict") return null;
  const cur = errorExtra(err).current;
  return cur && typeof cur === "object" ? (cur as T) : null;
}

/** Seconds left of a refresh cooldown (409 `knowledge.cooldown`), or null. */
export function cooldownSeconds(err: unknown): number | null {
  if (errorKey(err) !== "knowledge.cooldown") return null;
  const s = errorExtra(err).retryAfterSeconds;
  return typeof s === "number" && s > 0 ? s : null;
}
