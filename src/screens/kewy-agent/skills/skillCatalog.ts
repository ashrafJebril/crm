import type { SkillKey } from "@/lib/types";

/** SP-22: the catalog keys, mirrored from backend/src/skills/skill-catalog.ts
 *  (skillCatalog.test.ts pins equality). The server sends names, tools and
 *  fields; the client only adds an icon per key. */
export const SKILL_KEYS: readonly SkillKey[] = ["booking", "customer_records", "photos", "support_tickets", "lead_capture", "calendly_scheduling"];

export type SkillIcon = "cal" | "users" | "image" | "ticket" | "tag" | "link";

export const SKILL_ICON: Record<SkillKey, SkillIcon> = {
  booking: "cal",
  customer_records: "users",
  photos: "image",
  support_tickets: "ticket",
  lead_capture: "tag",
  calendly_scheduling: "link",
};

/** Connector providers, as shown in "Connect … first". */
export const PROVIDER_NAME: Record<string, string> = {
  calendly: "Calendly",
  hubspot: "HubSpot",
  pipedrive: "Pipedrive",
  custom: "MCP",
};

/** SP-23 builds the connectors screen; until then the link is hidden. */
export const CONNECTORS_HREF: string | null = null;

/** Mirrors the server's SAFE_TAG_RE (skill-config.ts): letters, digits, space, - _ . */
export const SAFE_TAG_RE = /^[\p{L}\p{M}\p{N} ._-]+$/u;
