export { CONNECTOR_PROVIDERS, type ConnectorProvider } from "../skills/skill-catalog";

/** SP-23 constants (plan: Global Constraints). */
export const CONNECTOR_CALL_RETENTION_DAYS = 90;
export const REFRESH_AHEAD_MS = 2 * 60_000;
export const REFRESH_SWEEP_AHEAD_MS = 2 * 60 * 60_000;
export const PROXY_ARGS_MAX_BYTES = 64 * 1024;
export const UPSTREAM_RESPONSE_MAX_BYTES = 1024 * 1024;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const CUSTOM_CONNECTORS_MAX = 10;
export const PATCH_TOOLS_MAX = 200;

export type GalleryProvider = "calendly" | "hubspot" | "pipedrive" | "salla" | "foodics" | "custom";
export type AuthKind = "oauth" | "headers" | "none";
export type ToolKind = "read" | "write";

export interface CatalogEntry {
  provider: GalleryProvider;
  name: { en: string; ar: string };
  description: { en: string; ar: string };
  authKind: AuthKind | null;
  /** Env var naming the upstream MCP URL, and its default. */
  urlEnv?: string;
  defaultUrl?: string;
  /** Tools switched on (as "read") when first scanned. Write tools stay off. */
  defaultOn?: readonly string[];
  /** Per-tool kind when the server sends no `readOnlyHint`. */
  kindOverrides?: Readonly<Record<string, ToolKind>>;
  /** Shown as "Coming soon" (ruling 1). */
  comingSoon?: boolean;
  /** Env vars the provider needs; missing → "not_configured" (ruling 12). */
  requiresEnv?: readonly string[];
}

/** Ruling 1: Calendly, HubSpot and custom now; Pipedrive, Salla, Foodics later. */
export const CONNECTOR_CATALOG: readonly CatalogEntry[] = [
  {
    provider: "calendly",
    name: { en: "Calendly", ar: "Calendly" },
    description: {
      en: "Let the agent check availability, look up events and book through your Calendly.",
      ar: "يتيح للوكيل معرفة الأوقات المتاحة والاطلاع على المواعيد والحجز عبر Calendly.",
    },
    authKind: "oauth",
    urlEnv: "CONNECTOR_CALENDLY_MCP_URL",
    defaultUrl: "https://mcp.calendly.com",
    defaultOn: [
      "users-get_current_user",
      "event_types-list_event_types",
      "event_types-list_event_type_available_times",
      "users-list_user_busy_times",
      "locations-list_locations",
      "scheduled_events-get_event",
    ],
    kindOverrides: {
      "users-get_current_user": "read",
      "event_types-list_event_types": "read",
      "event_types-list_event_type_available_times": "read",
      "users-list_user_busy_times": "read",
      "locations-list_locations": "read",
      "scheduled_events-get_event": "read",
      "scheduled_events-list_events": "read",
      "invitees-create_invitee": "write",
      "scheduling_links-create_single_use_link": "write",
      "scheduled_events-cancel_event": "write",
    },
  },
  {
    provider: "hubspot",
    name: { en: "HubSpot", ar: "HubSpot" },
    description: {
      en: "Let the agent look up contacts, companies and deals in HubSpot.",
      ar: "يتيح للوكيل البحث عن جهات الاتصال والشركات والصفقات في HubSpot.",
    },
    authKind: "oauth",
    urlEnv: "CONNECTOR_HUBSPOT_MCP_URL",
    defaultUrl: "https://mcp.hubspot.com",
    requiresEnv: ["HUBSPOT_MCP_CLIENT_ID", "HUBSPOT_MCP_CLIENT_SECRET"],
  },
  {
    provider: "pipedrive",
    name: { en: "Pipedrive", ar: "Pipedrive" },
    description: { en: "Deals and contacts from Pipedrive.", ar: "الصفقات وجهات الاتصال من Pipedrive." },
    authKind: null,
    comingSoon: true,
  },
  {
    provider: "salla",
    name: { en: "Salla", ar: "سلة" },
    description: { en: "Orders and products from your Salla store.", ar: "الطلبات والمنتجات من متجرك على سلة." },
    authKind: null,
    comingSoon: true,
  },
  {
    provider: "foodics",
    name: { en: "Foodics", ar: "فودكس" },
    description: { en: "Menu and orders from Foodics.", ar: "القائمة والطلبات من فودكس." },
    authKind: null,
    comingSoon: true,
  },
  {
    provider: "custom",
    name: { en: "Custom connector", ar: "موصل مخصص" },
    description: {
      en: "Any HTTPS MCP server, with optional secret headers. Every tool starts switched off.",
      ar: "أي خادم MCP عبر HTTPS، مع ترويسات سرية اختيارية. تبدأ كل الأدوات متوقفة.",
    },
    authKind: "headers",
  },
];

export function catalogEntry(provider: string): CatalogEntry | null {
  return CONNECTOR_CATALOG.find((e) => e.provider === provider) ?? null;
}

export type UnavailableReason = "not_configured" | "coming_soon" | null;

/** Whether the provider can be connected on this server, and why not. */
export function availability(entry: CatalogEntry, env: NodeJS.ProcessEnv = process.env): { available: boolean; unavailableReason: UnavailableReason } {
  if (entry.comingSoon) return { available: false, unavailableReason: "coming_soon" };
  if (entry.requiresEnv?.some((k) => !env[k]?.trim())) return { available: false, unavailableReason: "not_configured" };
  return { available: true, unavailableReason: null };
}

/**
 * The curated upstream URL (code or env: trusted). Must be https in
 * production; a loopback http URL is accepted only outside production
 * (verification stubs).
 */
export function curatedUrl(entry: CatalogEntry, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (entry.urlEnv && env[entry.urlEnv]?.trim()) || entry.defaultUrl;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "https:") return raw;
  if (u.protocol === "http:" && env.NODE_ENV !== "production" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return raw;
  return null;
}
