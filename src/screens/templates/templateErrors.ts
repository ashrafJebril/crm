import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { mediaKeyText } from "@/components/media/mediaErrors";
import type { Tx } from "@/lib/tx";

/**
 * Localized copy for the SP-14 template error keys (backend
 * `templates/template-errors.ts`). `templates.not_found` is live on
 * GET /templates/:id/health; the copy-to-number keys are reserved for the
 * follow-up and worded now so they never surface raw. Header-media keys stay
 * in `mediaErrors.ts` and are used as the fallback.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const STATUS_WORD: Record<string, [string, string]> = {
  approved: ["approved", "معتمد"],
  pending: ["in review", "قيد المراجعة"],
  rejected: ["rejected", "مرفوض"],
  paused: ["paused", "متوقف مؤقتًا"],
  disabled: ["disabled", "معطّل"],
};

export const TEMPLATE_ERROR_COPY: Record<string, CopyFn> = {
  "templates.not_found": () => ["This template no longer exists.", "هذا القالب لم يعد موجودًا."],
  "templates.number_invalid": () => [
    "That number can't receive a copy of this template. Pick another active WhatsApp number.",
    "لا يمكن نسخ هذا القالب إلى هذا الرقم. اختر رقم واتساب نشطًا آخر.",
  ],
  "templates.copy_requires_approved": () => [
    "Only a template Meta has approved on the default number can be copied.",
    "يمكن نسخ القالب فقط بعد أن تعتمده Meta على الرقم الافتراضي.",
  ],
  "templates.already_on_number": (x) => {
    const s = typeof x.status === "string" ? STATUS_WORD[x.status.toLowerCase()] : undefined;
    return s
      ? [`This template is already on that number (${s[0]}).`, `هذا القالب موجود بالفعل على ذلك الرقم (${s[1]}).`]
      : ["This template is already on that number.", "هذا القالب موجود بالفعل على ذلك الرقم."];
  },
  "templates.copy_unsupported": () => [
    "Copying templates to numbers connected directly to Meta isn't available yet.",
    "نسخ القوالب إلى الأرقام المربوطة مباشرةً بـ Meta غير متاح بعد.",
  ],
};

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

/** Copy for a template key (or a header-media key); null when unknown. */
export function templateKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const fn = TEMPLATE_ERROR_COPY[key];
  if (fn) {
    const [en, ar] = fn(isObject(extra) ? extra : {});
    return tx(en, ar);
  }
  return mediaKeyText(key, extra, tx);
}

/** User-facing text for any error from the template health routes. */
export function templateErrorText(err: unknown, tx: Tx): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const body = err instanceof ApiError ? err.body : undefined;
  return templateKeyText(message, body, tx) ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}
