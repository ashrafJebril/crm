/** Stored lifecycle values are lowercase; legacy rows may be capitalised. */
export const LIFECYCLES = ["lead", "customer", "churned", "patient", "blocked"];
const LABELS: Record<string, [string, string]> = {
  lead: ["Lead", "عميل محتمل"],
  customer: ["Customer", "عميل"],
  churned: ["Churned", "متوقف"],
  patient: ["Patient", "مريض"],
  blocked: ["Blocked", "محظور"],
};
/** Lowercases known lifecycle values (so a legacy "Lead" is "lead"); others pass through. */
export const normalizeLifecycle = (l: string): string => (l.toLowerCase() in LABELS ? l.toLowerCase() : l);
export const lifecycleLabel = (tx: (en: string, ar: string) => string, l: string): string => {
  const e = LABELS[l.toLowerCase()];
  return e ? tx(e[0], e[1]) : l;
};
/** The selectable values, plus the current one when it is not a known lifecycle. */
export const lifecycleOptions = (current: string): string[] => {
  const c = normalizeLifecycle(current);
  return LIFECYCLES.includes(c) || !c ? LIFECYCLES : [c, ...LIFECYCLES];
};
