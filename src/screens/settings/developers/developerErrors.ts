import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

/**
 * Copy for every SP-27 error key (backend api-key-errors.ts and
 * webhook-errors.ts; developerErrors.test.ts pins the list).
 */
export const DEVELOPER_ERROR_COPY: Record<string, [string, string]> = {
  "api_keys.scope_not_allowed": ["These permissions can't be given to a key.", "لا يمكن منح هذه الصلاحيات لمفتاح."],
  "api_keys.invalid_expiry": ["Choose an expiry date in the future, within 2 years.", "اختر تاريخ انتهاء في المستقبل، خلال سنتين."],
  "api_keys.invalid_name": ["Give the key a name (up to 60 characters).", "أدخل اسمًا للمفتاح (حتى 60 حرفًا)."],
  "api_keys.invalid": ["This API key is not valid.", "مفتاح API هذا غير صالح."],
  "api_keys.route_not_allowed": ["API keys can't be used for this.", "لا يمكن استخدام مفاتيح API لهذا الإجراء."],
  "api_keys.scope_above_role": ["A key can't have more access than you have.", "لا يمكن أن يملك المفتاح صلاحيات أكثر من صلاحياتك."],
  "api_keys.not_found": ["This key no longer exists.", "هذا المفتاح لم يعد موجودًا."],
  "api_keys.limit_reached": ["You have reached 25 active keys. Revoke one first.", "وصلت إلى 25 مفتاحًا نشطًا. ألغِ أحدها أولًا."],
  "api_keys.rate_limited": ["Too many requests. Try again shortly.", "طلبات كثيرة جدًا. حاول بعد قليل."],
  "webhooks.unsafe_url": [
    "Use a public https:// address (port 443 or 8443). Private and local addresses are not allowed.",
    "استخدم عنوان https:// عامًا (المنفذ 443 أو 8443). العناوين الخاصة والمحلية غير مسموحة.",
  ],
  "webhooks.invalid_events": ["Choose at least one event.", "اختر حدثًا واحدًا على الأقل."],
  "webhooks.url_immutable": [
    "The URL can't be changed. Delete this webhook and create a new one.",
    "لا يمكن تغيير الرابط. احذف هذا الويب هوك وأنشئ واحدًا جديدًا.",
  ],
  "webhooks.invalid_description": ["The description is too long (200 characters at most).", "الوصف طويل جدًا (200 حرف كحد أقصى)."],
  "webhooks.not_found": ["This webhook no longer exists.", "هذا الويب هوك لم يعد موجودًا."],
  "webhooks.limit_reached": ["You can have up to 10 webhooks.", "يمكنك إضافة 10 ويب هوكس كحد أقصى."],
  "webhooks.encryption_unavailable": [
    "Webhooks are not available right now (secret storage is not configured).",
    "الويب هوكس غير متاحة حاليًا (تخزين الأسرار غير مهيأ).",
  ],
};

export const DEVELOPER_ERROR_KEYS = Object.keys(DEVELOPER_ERROR_COPY);

function bodyMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const b = e.body;
  const m = b && typeof b === "object" ? (b as Record<string, unknown>).message : null;
  return typeof m === "string" ? m : e.message;
}

export function developerErrorText(e: unknown, tx: Tx): string {
  const key = bodyMessage(e);
  if (key && DEVELOPER_ERROR_COPY[key]) {
    const [en, ar] = DEVELOPER_ERROR_COPY[key]!;
    return tx(en, ar);
  }
  if (e instanceof ApiError && e.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}
