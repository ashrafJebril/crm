/**
 * SP-28 "Not in your plan" (pure). Kewy bills the workspace, so there is no
 * upgrade checkout here: the notice links to the Kewy billing page when the
 * viewer may see billing and the link is configured (VITE_KEWY_BILLING_URL),
 * otherwise it asks them to contact the workspace owner.
 */
import type { Lang } from "@/lib/types";
import { featureLabel, planLabel } from "./billingModel";

type Copy = [en: string, ar: string];

export interface PlanGateView {
  title: Copy;
  body: Copy;
  action: { kind: "kewy"; href: string; label: Copy } | { kind: "contact_owner"; label: Copy };
}

export const NOT_IN_PLAN_TITLE: Copy = ["Not in your plan", "غير متاح في باقتك"];
export const MANAGE_IN_KEWY: Copy = ["Manage your plan in Kewy", "أدر باقتك عبر كيوي"];
export const CONTACT_OWNER: Copy = ["Contact your workspace owner to change the plan.", "تواصل مع مالك مساحة العمل لتغيير الباقة."];

export function planGateView(
  info: { feature: string | null; requiredPlan: string | null },
  o: { canViewBilling: boolean; kewyBillingUrl: string | undefined },
): PlanGateView {
  const f: Copy = info.feature ? [featureLabel(info.feature, "en"), featureLabel(info.feature, "ar")] : ["This feature", "هذه الميزة"];
  const plan: Copy | null = info.requiredPlan ? [planLabel(info.requiredPlan, "en"), planLabel(info.requiredPlan, "ar")] : null;
  const body: Copy = plan
    ? [`${f[0]} is available on the ${plan[0]} plan and above.`, `${f[1]} متاحة في باقة ${plan[1]} وما فوقها.`]
    : [`${f[0]} isn't included in your current plan.`, `${f[1]} غير مشمولة في باقتك الحالية.`];
  const action: PlanGateView["action"] =
    o.canViewBilling && o.kewyBillingUrl
      ? { kind: "kewy", href: o.kewyBillingUrl, label: MANAGE_IN_KEWY }
      : { kind: "contact_owner", label: CONTACT_OWNER };
  return { title: NOT_IN_PLAN_TITLE, body, action };
}

/** Whether a status lets a feature through (features is the server's list for the plan). */
export const featureIncluded = (status: { features: string[] } | null | undefined, feature: string) =>
  !status || status.features.includes(feature);

export const pickCopy = (c: Copy, lang: Lang) => c[lang === "ar" ? 1 : 0];
