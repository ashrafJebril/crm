// Template placeholder mapping for campaign broadcasts. Zernio fills each
// {{n}} per recipient from their contact (name, phone) or with one fixed value.
import type { CampaignVariable } from "@/lib/types";

export function placeholderCount(body: string | null | undefined): number {
  let max = 0;
  for (const m of (body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

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
