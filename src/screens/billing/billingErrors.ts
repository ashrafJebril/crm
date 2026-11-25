import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Lang } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { featureLabel, planLabel } from "./billingModel";

/**
 * SP-28 copy for the backend's billing keys (backend/src/billing/billing-errors.ts;
 * billing.test.ts pins the list): the 400 keys and the two 402 messages,
 * `billing.plan_required` (code PLAN_REQUIRED) and `billing.wallet_empty`
 * (code WALLET_EMPTY).
 */
type Extra = Record<string, unknown>;
type CopyFn = (x: Extra, lang: Lang) => [en: string, ar: string];

export const PLAN_REQUIRED = "PLAN_REQUIRED";
export const WALLET_EMPTY = "WALLET_EMPTY";

export const BILLING_ERROR_COPY: Record<string, CopyFn> = {
  "billing.invalid_amount": () => ["Enter a valid amount.", "أدخل مبلغًا صحيحًا."],
  "billing.invalid_range": (x) => {
    const days = typeof x.maxDays === "number" ? x.maxDays : 92;
    return [`Choose a date range of up to ${days} days.`, `اختر فترة لا تتجاوز ${days} يومًا.`];
  },
  "billing.invalid_meter": () => ["That usage type doesn't exist.", "نوع الاستهلاك هذا غير موجود."],
  "billing.plan_required": (x, lang) => {
    const f = typeof x.feature === "string" ? featureLabel(x.feature, lang) : null;
    const plan = typeof x.requiredPlan === "string" ? planLabel(x.requiredPlan, lang) : null;
    if (f && plan) return [`${f} isn't in your plan. It needs the ${plan} plan.`, `${f} غير متاحة في باقتك. تحتاج إلى باقة ${plan}.`];
    if (f) return [`${f} isn't in your plan.`, `${f} غير متاحة في باقتك.`];
    return ["This isn't in your plan.", "هذه الميزة غير متاحة في باقتك."];
  },
  "billing.wallet_empty": () => ["Your wallet doesn't have enough balance for this.", "رصيد محفظتك لا يكفي لهذا."],
};

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

export function billingKeyText(key: string, extra: unknown, tx: Tx, lang: Lang): string | null {
  const fn = BILLING_ERROR_COPY[key];
  if (!fn) return null;
  const [en, ar] = fn(isObject(extra) ? extra : {}, lang);
  return tx(en, ar);
}

/** The `{feature, requiredPlan}` of a 402 PLAN_REQUIRED, else null (a WALLET_EMPTY 402 is not an upgrade). */
export function planRequiredOf(err: unknown): { feature: string | null; requiredPlan: string | null } | null {
  if (!(err instanceof ApiError) || err.status !== 402 || err.code !== PLAN_REQUIRED) return null;
  const b = isObject(err.body) ? err.body : {};
  return {
    feature: typeof b.feature === "string" ? b.feature : null,
    requiredPlan: typeof b.requiredPlan === "string" ? b.requiredPlan : null,
  };
}

export function billingErrorText(err: unknown, tx: Tx, lang: Lang): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
    const own = billingKeyText(err.message, err.body, tx, lang);
    if (own) return own;
  }
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مرة أخرى.");
}
