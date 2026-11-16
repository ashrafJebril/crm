import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

/**
 * SP-11 copy for the backend's insights error keys
 * (backend/src/insights/insights-errors.ts); pinned by insightsErrors.test.ts.
 */
export const INSIGHTS_ERROR_COPY: Record<string, [en: string, ar: string]> = {
  "insights.range_invalid": [
    "Choose a valid date range of up to 366 days.",
    "اختر فترة صحيحة لا تتجاوز 366 يومًا.",
  ],
  "insights.channel_not_found": [
    "That WhatsApp number isn't available. Showing all numbers.",
    "رقم واتساب هذا غير متاح. تُعرض جميع الأرقام.",
  ],
  "insights.pipeline_not_found": [
    "That pipeline isn't available. Choose another one.",
    "هذا المسار غير متاح. اختر مسارًا آخر.",
  ],
};

/** The backend key of an error (an `Error` or `useFetch`'s message string). */
export function insightsErrorKey(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg.split(", ")[0]?.trim() ?? "";
}

export function insightsErrorText(err: unknown, tx: Tx): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const c = INSIGHTS_ERROR_COPY[insightsErrorKey(err)];
  return c ? tx(c[0], c[1]) : tx("The report couldn't load. Try again.", "تعذّر تحميل التقرير. حاول مجددًا.");
}
