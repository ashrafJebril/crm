import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { dayName } from "./schedule";
import type { Weekday } from "./bookingTime";
import { WEEKDAYS } from "./bookingTime";

/**
 * SP-10 copy for the backend's booking and catalog-import error keys
 * (backend/src/bookings/booking-errors.ts, backend/src/catalog-import/
 * catalog-import-errors.ts). The key is the error's `message`; extras ride in
 * the body. bookingErrors.test.ts pins the key list to the backend files.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** `bookings.schedule_invalid` reasons (the row the editor highlights). */
export const SCHEDULE_REASON_COPY: Record<string, [string, string]> = {
  not_object: ["The schedule is not in the right format.", "صيغة الجدول غير صحيحة."],
  unknown_day: ["The schedule names a day that doesn't exist.", "الجدول يحتوي على يوم غير معروف."],
  not_array: ["A day's hours are not in the right format.", "صيغة ساعات اليوم غير صحيحة."],
  too_many_windows: ["A day can have at most 3 time ranges.", "يمكن أن يحتوي اليوم على 3 فترات كحد أقصى."],
  window_invalid: ["This time range is not in the right format.", "صيغة هذه الفترة غير صحيحة."],
  time_invalid: ["Use a time between 00:00 and 24:00.", "استخدم وقتًا بين 00:00 و24:00."],
  start_at_24: ["A range cannot start at 24:00.", "لا يمكن أن تبدأ الفترة عند 24:00."],
  from_not_before_to: [
    "The start must be before the end. Split overnight hours across two days.",
    "يجب أن يكون البدء قبل الانتهاء. قسّم ساعات الليل على يومين.",
  ],
  overlap: ["This range overlaps another range on the same day.", "هذه الفترة تتداخل مع فترة أخرى في اليوم نفسه."],
};

export function scheduleReasonText(reason: string, tx: Tx): string {
  const c = SCHEDULE_REASON_COPY[reason];
  return c ? tx(c[0], c[1]) : tx("Check this day's hours.", "تحقق من ساعات هذا اليوم.");
}

const fitText = (x: Extra): [string, string] => {
  const fit = isObject(x.fit) ? x.fit : {};
  const day = (WEEKDAYS as readonly string[]).includes(fit.day as string) ? (fit.day as Weekday) : null;
  if (fit.kind === "off_day" && day) {
    return [`${dayName(day, "en")} is a day off for this staff member.`, `${dayName(day, "ar")} يوم عطلة لهذا الموظف.`];
  }
  const windows = Array.isArray(fit.windows)
    ? (fit.windows as { from?: string; to?: string }[]).map((w) => `${w.from}–${w.to}`).join(", ")
    : "";
  return windows
    ? [`Outside working hours (${windows}).`, `خارج ساعات العمل (${windows}).`]
    : ["Outside working hours.", "خارج ساعات العمل."];
};

export const BOOKING_ERROR_COPY: Record<string, CopyFn> = {
  // Catalog (Task 1)
  "bookings.name_required": (x) => [
    `Enter a name (up to ${num(x.max, 120)} characters).`,
    `أدخل اسمًا (حتى ${num(x.max, 120)} حرفًا).`,
  ],
  "bookings.duration_invalid": (x) => [
    `Duration must be between ${num(x.min, 5)} and ${num(x.max, 1440)} minutes.`,
    `يجب أن تكون المدة بين ${num(x.min, 5)} و${num(x.max, 1440)} دقيقة.`,
  ],
  "bookings.price_invalid": () => ["Enter a price such as 120 or 120.50.", "أدخل سعرًا مثل 120 أو 120.50."],
  "bookings.currency_invalid": () => ["Use a 3-letter currency code such as SAR.", "استخدم رمز عملة من 3 أحرف مثل SAR."],
  "bookings.color_invalid": () => ["Choose a colour from the list.", "اختر لونًا من القائمة."],
  "bookings.schedule_invalid": (x) => {
    const c = SCHEDULE_REASON_COPY[String(x.reason)] ?? ["Check the working hours.", "تحقق من ساعات العمل."];
    return [c[0], c[1]];
  },
  "bookings.not_a_member": () => ["That person is not a member of this workspace.", "هذا الشخص ليس عضوًا في مساحة العمل."],
  "bookings.member_has_resource": () => [
    "That member already has a staff profile. Edit or restore that one instead.",
    "لهذا العضو ملف موظف بالفعل. عدّله أو استعده بدلًا من ذلك.",
  ],
  "bookings.version_conflict": () => [
    "Someone else changed this while you were editing.",
    "عدّل شخص آخر هذا العنصر أثناء تعديلك.",
  ],
  "bookings.service_not_found": () => ["That service no longer exists.", "هذه الخدمة لم تعد موجودة."],
  "bookings.resource_not_found": () => ["That staff member no longer exists.", "هذا الموظف لم يعد موجودًا."],
  "bookings.resource_archived": () => ["That staff member is archived or paused.", "هذا الموظف مؤرشف أو موقوف."],
  // Booking engine (Task 2)
  "bookings.service_archived": () => ["That service is archived or paused.", "هذه الخدمة مؤرشفة أو موقوفة."],
  "bookings.resource_not_offering": () => [
    "That staff member doesn't offer this service.",
    "هذا الموظف لا يقدّم هذه الخدمة.",
  ],
  "bookings.service_required": () => ["Choose a service or enter its name and duration.", "اختر خدمة أو أدخل اسمها ومدتها."],
  "bookings.date_invalid": (x) => [
    `Pick a date from today up to ${num(x.maxDaysAhead, 365)} days ahead.`,
    `اختر تاريخًا من اليوم حتى ${num(x.maxDaysAhead, 365)} يومًا قادمًا.`,
  ],
  "bookings.range_invalid": (x) => [
    `Choose a range of at most ${num(x.maxDays, 92)} days.`,
    `اختر فترة لا تتجاوز ${num(x.maxDays, 92)} يومًا.`,
  ],
  "bookings.outside_schedule": fitText,
  "bookings.illegal_transition": () => [
    "This booking can't move to that status.",
    "لا يمكن نقل هذا الحجز إلى هذه الحالة.",
  ],
  "bookings.closed": () => [
    "This booking is closed, so its time and staff can't change.",
    "هذا الحجز مغلق، لذا لا يمكن تغيير وقته أو موظفه.",
  ],
  SLOT_TAKEN: () => ["That time was just taken. Pick another slot.", "تم حجز هذا الوقت للتو. اختر وقتًا آخر."],
  // Catalog import (Task 3)
  "catalog_import.text_too_long": (x) => [
    `The text is too long (up to ${num(x.max, 200000).toLocaleString("en-US")} characters).`,
    `النص طويل جدًا (حتى ${num(x.max, 200000).toLocaleString("en-US")} حرف).`,
  ],
  "catalog_import.url_invalid": () => [
    "Enter a full website address starting with https://",
    "أدخل عنوان موقع كاملًا يبدأ بـ https://",
  ],
  "catalog_import.url_blocked": () => [
    "That address can't be imported. Use a public website.",
    "لا يمكن الاستيراد من هذا العنوان. استخدم موقعًا عامًا.",
  ],
  "catalog_import.url_fetch_failed": () => [
    "We couldn't read that page. Check the address, or paste the text instead.",
    "تعذّرت قراءة الصفحة. تحقق من العنوان أو الصق النص بدلًا من ذلك.",
  ],
  "catalog_import.file_invalid": () => [
    "Upload a CSV or Excel (.xlsx) file up to 10 MB. PDF isn't supported.",
    "ارفع ملف CSV أو Excel (‎.xlsx) حتى 10 ميغابايت. ملفات PDF غير مدعومة.",
  ],
  "catalog_import.too_many_rows": (x) => [
    `The file has too many rows (up to ${num(x.max, 2000).toLocaleString("en-US")}).`,
    `يحتوي الملف على صفوف كثيرة جدًا (حتى ${num(x.max, 2000).toLocaleString("en-US")}).`,
  ],
  "catalog_import.ai_unavailable": () => [
    "Automatic reading isn't available right now. Download a template, fill it in and upload it.",
    "القراءة التلقائية غير متاحة الآن. نزّل قالبًا واملأه ثم ارفعه.",
  ],
  "catalog_import.ai_failed": () => [
    "We couldn't read the services and staff from this. Try again, or use a template.",
    "تعذّرت قراءة الخدمات والموظفين من هذا المحتوى. حاول مجددًا أو استخدم قالبًا.",
  ],
  "catalog_import.nothing_found": () => [
    "No services or staff were found.",
    "لم يُعثر على أي خدمات أو موظفين.",
  ],
  "catalog_import.not_in_review": () => [
    "This import has moved on. Refresh to see where it is.",
    "تقدّمت عملية الاستيراد هذه. حدّث الصفحة لمعرفة حالتها.",
  ],
  "catalog_import.item_invalid": (x) => {
    const field = typeof x.field === "string" ? x.field : "";
    const f: Record<string, [string, string]> = {
      durationMin: ["Duration must be between 5 and 1,440 minutes.", "يجب أن تكون المدة بين 5 و1,440 دقيقة."],
      price: ["Enter a price such as 120 or 120.50.", "أدخل سعرًا مثل 120 أو 120.50."],
      schedule: ["Check the working hours.", "تحقق من ساعات العمل."],
      name: ["Enter a name.", "أدخل اسمًا."],
      nameAr: ["Enter an Arabic name.", "أدخل اسمًا بالعربية."],
      currency: ["Use a 3-letter currency code such as SAR.", "استخدم رمز عملة من 3 أحرف مثل SAR."],
    };
    return f[field] ?? ["Check this row.", "تحقق من هذا الصف."];
  },
  "catalog_import.not_found": () => ["This import no longer exists.", "عملية الاستيراد هذه لم تعد موجودة."],
  "catalog_import.source_invalid": () => [
    "Choose what to import: pasted text, a website or a file.",
    "اختر مصدر الاستيراد: نص ملصق أو موقع أو ملف.",
  ],
  "catalog_import.already_finished": () => ["This import has already finished.", "انتهت عملية الاستيراد هذه بالفعل."],
  // Untyped 404s the booking routes send.
  "Appointment not found": () => ["This booking no longer exists.", "هذا الحجز لم يعد موجودًا."],
  "Contact not found": () => ["That contact no longer exists.", "جهة الاتصال هذه لم تعد موجودة."],
};

/** Copy for a booking/import key with its extras, or null when the key is not one. */
export function bookingKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const copy = BOOKING_ERROR_COPY[key];
  if (!copy) return null;
  const [en, ar] = copy(isObject(extra) ? extra : {});
  return tx(en, ar);
}

/** The error's key (a ValidationPipe refusal joins `message: [key]` with ", "). */
export function errorKey(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  return message.split(", ")[0] ?? "";
}

/** User-facing text for any error from the SP-10 routes. */
export function bookingErrorText(err: unknown, tx: Tx, fallback?: string): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const key = errorKey(err);
  const body = err instanceof ApiError ? err.body : undefined;
  return bookingKeyText(key, body, tx) ?? fallback ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}

/** The `current` row of a 409 version_conflict, for "Load theirs". */
export function conflictCurrent<T>(err: unknown): T | null {
  if (!(err instanceof ApiError) || err.status !== 409 || errorKey(err) !== "bookings.version_conflict") return null;
  const body = err.body;
  return isObject(body) && isObject(body.current) ? (body.current as T) : null;
}
