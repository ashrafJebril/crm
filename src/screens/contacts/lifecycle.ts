export const LIFECYCLES = ["Lead", "Customer", "Churned", "Patient"];
export const LIFECYCLE_AR: Record<string, string> = {
  Lead: "محتمل",
  Customer: "عميل",
  Churned: "متوقف",
  Patient: "مريض",
};
export const lifecycleLabel = (tx: (en: string, ar: string) => string, l: string): string =>
  l in LIFECYCLE_AR ? tx(l, LIFECYCLE_AR[l]) : l;
