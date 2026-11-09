// Pre-SP-13 placeholder mapping (the legacy launch body `variables`). SP-13
// replaced it with `varMap.ts`; this module keeps the legacy helpers and
// re-exports the shared ones for any remaining imports.
import type { CampaignVariable } from "@/lib/types";

export { legacyToVarMap, placeholderCount } from "./varMap";

const SAMPLE: Record<"name" | "phone", string> = { name: "Lina", phone: "+962 79 123 4567" };

/** The template body as one recipient would see it, using sample contact values. */
export function renderCampaignPreview(body: string, mapping: CampaignVariable[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => {
    const v = mapping[Number(n) - 1];
    if (!v) return whole;
    if (v.field === "custom") return v.customValue.trim() || whole;
    return SAMPLE[v.field];
  });
}

export function mappingComplete(mapping: CampaignVariable[], count: number): boolean {
  if (mapping.length < count) return false;
  return mapping.slice(0, count).every((v) => v.field !== "custom" || v.customValue.trim().length > 0);
}
