import { CALENDLY_PROBE_TOOL, calendlyLabel } from "./calendly";
import { HUBSPOT_PROBE_TOOL, hubspotLabel } from "./hubspot";

/** The read-only label probe per curated provider (allowed even when switched off; logged as source "probe"). */
export const PROVIDER_PROBES: Record<string, { tool: string; label(content: unknown[]): string | null }> = {
  calendly: { tool: CALENDLY_PROBE_TOOL, label: calendlyLabel },
  hubspot: { tool: HUBSPOT_PROBE_TOOL, label: hubspotLabel },
};
