/**
 * SP-14 number health: the stored `Channel.health` JSON (v1) and the pure
 * functions that build it from a provider read. No I/O here.
 *
 * The roadmap rule, enforced in one place (`toSignal`): a value the provider
 * cannot supply is "unknown", never a guess or a default. A failed read is
 * "unknown" too, and the previous value survives only in `lastKnown`, as a
 * previous value, never as the current one.
 */

/** The only sentinel; lowercase so it never collides with a provider value. */
export const UNKNOWN = "unknown" as const;
export type Unknown = typeof UNKNOWN;

export type SignalError =
  | null
  | "unsupported" // the provider cannot supply it (permanent)
  | "check_failed"
  | "permission_denied"
  | "missing_data" // the provider answered, but not with a value we know
  | "missing_credentials";

export interface Signal {
  value: string;
  checkedAt: string | null;
  error: SignalError;
  /**
   * Ruling R1: set when the value came from a field Zernio does not
   * document but passed through unchanged from Meta. Absent otherwise.
   */
  source?: "zernio_passthrough";
}

export const SIGNAL_NAMES = [
  "quality",
  "tier",
  "nameStatus",
  "verified",
  "codeVerification",
  "messaging",
  "phoneStatus",
  "accountReview",
] as const;
export type FieldName = (typeof SIGNAL_NAMES)[number];
export type SignalName = FieldName | "templates";

export interface TemplateItem {
  id: string | null;
  name: string;
  language: string;
  status: string;
  quality: string; // GREEN | YELLOW | RED | NOT_RATED | "unknown"
  category: string | null;
}

export interface TemplateSummary {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  paused: number;
  disabled: number;
  lowQuality: number;
  items: TemplateItem[];
  truncated: boolean;
}

export interface TemplatesSignal {
  value: TemplateSummary | Unknown;
  checkedAt: string | null;
  error: SignalError;
}

export type AlertSignal = "quality" | "messaging" | "phoneStatus" | "nameStatus" | "accountReview" | "tier" | "templatesBad";

export interface HealthAlerts {
  baselineAt: string;
  levels: Partial<Record<AlertSignal, number | string>>;
}

export type HealthProvider = "zernio" | "meta";
export type HealthTrigger = "manual" | "sweep" | "webhook";
export type Overall = "healthy" | "attention" | "critical" | "unknown";

export interface ChannelHealth {
  v: 1;
  provider: HealthProvider;
  checkedAt: string | null;
  trigger: HealthTrigger;
  overall: Overall;
  quality: Signal;
  tier: Signal;
  nameStatus: Signal;
  verified: Signal;
  codeVerification: Signal;
  messaging: Signal;
  phoneStatus: Signal;
  accountReview: Signal;
  templates: TemplatesSignal;
  issues: string[];
  lastKnown: Partial<Record<FieldName, { value: string; checkedAt: string }>>;
  /** Null only between `mergeHealth` and `evaluateAlerts` (the service sets it before writing). */
  alerts: HealthAlerts | null;
}

/** What `ChannelDto.health` carries: no alerts, no template items. */
export type ChannelHealthPublic = Omit<ChannelHealth, "alerts" | "templates"> & {
  templates: { value: Omit<TemplateSummary, "items"> | Unknown; checkedAt: string | null; error: SignalError };
};

// ─── Raw reads (what the provider readers produce) ──────────────────────────

/** A field's raw provider value, or why there is none. A field missing from
 *  `RawHealthRead.fields` is one the provider cannot supply (`unsupported`). */
export type RawField =
  | { value: unknown; passthrough?: boolean }
  | { error: Exclude<SignalError, null> };

export interface RawTemplate {
  id: string | null;
  name: string;
  language: string;
  status: unknown;
  category: string | null;
  /** The raw `quality_score.score`; undefined when the provider sent none. */
  qualityScore?: unknown;
}

export interface RawHealthRead {
  provider: HealthProvider;
  fields: Partial<Record<FieldName, RawField>>;
  templates: { items: RawTemplate[]; truncated: boolean } | { error: Exclude<SignalError, null> };
}

// ─── Normalizers ────────────────────────────────────────────────────────────

const upper = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null);
const IDENT = /^[A-Z0-9_]{1,64}$/;

/** Phone quality: GREEN | YELLOW | RED; Meta's NA → NOT_RATED. Anything else
 *  (Zernio's own UNKNOWN included: it does not say "not rated" vs "not read") → null. */
export function normalizeQuality(v: unknown): string | null {
  const u = upper(v);
  if (u === "GREEN" || u === "YELLOW" || u === "RED") return u;
  if (u === "NA") return "NOT_RATED";
  return null;
}

/** Template quality: GREEN | YELLOW | RED; Meta's template UNKNOWN ("quality
 *  pending") → NOT_RATED, so it never reads as our "unknown". */
export function normalizeTemplateQuality(v: unknown): string | null {
  const u = upper(v);
  if (u === "GREEN" || u === "YELLOW" || u === "RED") return u;
  if (u === "UNKNOWN" || u === "NA") return "NOT_RATED";
  return null;
}

/** Tier: open-ended (`TIER_*` verbatim, or a positive integer as digits). */
export function normalizeTier(v: unknown): string | null {
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? String(v) : null;
  const u = upper(v);
  if (!u) return null;
  if (/^\d{1,12}$/.test(u)) return Number(u) > 0 ? String(Number(u)) : null;
  return /^TIER_[A-Z0-9_]{1,32}$/.test(u) ? u : null;
}

const TIER_CAPS: Record<string, number> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: Number.POSITIVE_INFINITY,
};

/** Daily cap of a tier; Infinity for TIER_UNLIMITED; null when not a cap
 *  (TIER_NOT_SET, unknown, an unrecognised tier name). */
export function tierCap(tier: string | null | undefined): number | null {
  if (!tier) return null;
  if (/^\d+$/.test(tier)) return Number(tier);
  return TIER_CAPS[tier] ?? null;
}

const ENUMS: Partial<Record<FieldName, ReadonlySet<string>>> = {
  nameStatus: new Set(["APPROVED", "AVAILABLE_WITHOUT_REVIEW", "PENDING_REVIEW", "DECLINED", "EXPIRED", "NONE"]),
  codeVerification: new Set(["VERIFIED", "UNVERIFIED", "NOT_VERIFIED", "EXPIRED"]),
  messaging: new Set(["AVAILABLE", "LIMITED", "BLOCKED"]),
  accountReview: new Set(["APPROVED", "DEFERRED", "PENDING", "REJECTED"]),
};
const VERIFIED_FIXED = new Set(["VERIFIED", "NOT_VERIFIED", "REJECTED", "EXPIRED", "FAILED", "INELIGIBLE", "REVOKED"]);

/** One field's provider value → our value, or null when outside its known set. */
export function normalizeField(field: FieldName, raw: unknown): string | null {
  switch (field) {
    case "quality":
      return normalizeQuality(raw);
    case "tier":
      return normalizeTier(raw);
    case "phoneStatus": {
      const u = upper(raw);
      return u && IDENT.test(u) ? u : null;
    }
    case "verified": {
      const u = upper(raw);
      return u && (VERIFIED_FIXED.has(u) || /^PENDING(_[A-Z_]{1,40})?$/.test(u)) ? u : null;
    }
    case "messaging": {
      // Meta's `health_status` object; we read `can_send_message` only.
      const v =
        raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { can_send_message?: unknown }).can_send_message : raw;
      const u = upper(v);
      return u && ENUMS.messaging!.has(u) ? u : null;
    }
    default: {
      const u = upper(raw);
      return u && ENUMS[field]!.has(u) ? u : null;
    }
  }
}

/** The one place a raw field becomes a Signal. */
export function toSignal(raw: RawField | undefined, field: FieldName, opts: { provider: HealthProvider; now: Date }): Signal {
  const at = opts.now.toISOString();
  if (!raw) return { value: UNKNOWN, checkedAt: null, error: "unsupported" };
  if ("error" in raw) return { value: UNKNOWN, checkedAt: raw.error === "unsupported" ? null : at, error: raw.error };
  if (raw.value === undefined || raw.value === null) {
    // An undocumented passthrough that is absent is simply unsupported (R1).
    if (raw.passthrough) return { value: UNKNOWN, checkedAt: null, error: "unsupported" };
    return { value: UNKNOWN, checkedAt: at, error: "missing_data" };
  }
  const value = normalizeField(field, raw.value);
  if (value === null) {
    if (raw.passthrough) return { value: UNKNOWN, checkedAt: null, error: "unsupported" };
    return { value: UNKNOWN, checkedAt: at, error: "missing_data" };
  }
  return { value, checkedAt: at, error: null, ...(raw.passthrough ? { source: "zernio_passthrough" as const } : {}) };
}

// ─── Templates ──────────────────────────────────────────────────────────────

export const TEMPLATE_ITEMS_MAX = 500;
const PENDING_STATUSES = new Set(["PENDING", "IN_APPEAL", "PENDING_DELETION", "SUBMITTED"]);

export function summarizeTemplates(
  items: RawTemplate[],
  opts: { max?: number; truncated?: boolean } = {},
): TemplateSummary {
  const max = opts.max ?? TEMPLATE_ITEMS_MAX;
  const s: TemplateSummary = {
    total: items.length,
    approved: 0,
    pending: 0,
    rejected: 0,
    paused: 0,
    disabled: 0,
    lowQuality: 0,
    items: [],
    truncated: !!opts.truncated || items.length > max,
  };
  for (const t of items) {
    const status = upper(t.status) ?? UNKNOWN;
    if (status === "APPROVED") s.approved++;
    else if (status === "REJECTED") s.rejected++;
    else if (status === "PAUSED") s.paused++;
    else if (status === "DISABLED") s.disabled++;
    else if (PENDING_STATUSES.has(status)) s.pending++;
    const quality = t.qualityScore === undefined ? null : normalizeTemplateQuality(t.qualityScore);
    if (quality === "YELLOW" || quality === "RED") s.lowQuality++;
    if (s.items.length < max) {
      s.items.push({
        id: t.id ?? null,
        name: String(t.name ?? ""),
        language: String(t.language ?? ""),
        status,
        quality: quality ?? UNKNOWN,
        category: t.category ?? null,
      });
    }
  }
  return s;
}

// ─── Issues and overall ─────────────────────────────────────────────────────

const known = (s: { value: unknown } | undefined) => !!s && s.value !== UNKNOWN;

export function computeIssues(h: Pick<ChannelHealth, FieldName | "templates">): string[] {
  const out: string[] = [];
  const v = (f: FieldName) => (known(h[f]) ? h[f].value : null);
  const q = v("quality");
  if (q === "RED") out.push("quality_red");
  if (q === "YELLOW") out.push("quality_yellow");
  const m = v("messaging");
  if (m === "BLOCKED") out.push("messaging_blocked");
  if (m === "LIMITED") out.push("messaging_limited");
  const ps = v("phoneStatus");
  if (ps && ps !== "CONNECTED") out.push(`phone_status_${ps.toLowerCase()}`);
  const n = v("nameStatus");
  if (n === "DECLINED") out.push("name_declined");
  if (n === "EXPIRED") out.push("name_expired");
  if (n === "PENDING_REVIEW") out.push("name_pending");
  if (v("accountReview") === "REJECTED") out.push("account_review_rejected");
  const bv = v("verified");
  if (bv && bv !== "VERIFIED") out.push(`verification_${bv.toLowerCase()}`);
  const t = h.templates?.value;
  if (t && t !== UNKNOWN) {
    if (t.paused > 0) out.push("templates_paused");
    if (t.disabled > 0) out.push("templates_disabled");
    if (t.lowQuality > 0) out.push("templates_low_quality");
  }
  const incomplete =
    SIGNAL_NAMES.some((f) => !known(h[f]) && h[f]?.error !== "unsupported") ||
    (h.templates?.value === UNKNOWN && h.templates.error !== "unsupported");
  if (incomplete) out.push("check_incomplete");
  return out;
}

const CRITICAL_PHONE = new Set(["RESTRICTED", "BANNED", "DISCONNECTED"]);

export function computeOverall(h: Pick<ChannelHealth, FieldName | "templates">, issues = computeIssues(h)): Overall {
  if (
    h.messaging.value === "BLOCKED" ||
    h.quality.value === "RED" ||
    CRITICAL_PHONE.has(h.phoneStatus.value) ||
    h.accountReview.value === "REJECTED" ||
    h.nameStatus.value === "DECLINED"
  )
    return "critical";
  if (issues.some((i) => i !== "check_incomplete")) return "attention";
  if (known(h.quality) && known(h.messaging)) return "healthy";
  return "unknown";
}

// ─── Merge ──────────────────────────────────────────────────────────────────

/** Errors after which the previous known value is kept in `lastKnown`. */
const KEEPS_LAST: ReadonlySet<SignalError> = new Set<SignalError>([
  "check_failed",
  "permission_denied",
  "missing_credentials",
  "missing_data",
]);

/** A stored health JSON, if it is one (anything else reads as no health). */
export function asChannelHealth(v: unknown): ChannelHealth | null {
  return v && typeof v === "object" && !Array.isArray(v) && (v as { v?: unknown }).v === 1 ? (v as ChannelHealth) : null;
}

/**
 * Build the new health from a read. Carries `lastKnown` (the previous known
 * value of every field that is now unknown for a failed read) and `alerts`
 * (unchanged; `evaluateAlerts` updates them).
 */
export function mergeHealth(
  previous: ChannelHealth | null,
  read: RawHealthRead,
  opts: { now: Date; trigger: HealthTrigger },
): ChannelHealth {
  const signals = {} as Record<FieldName, Signal>;
  const lastKnown: ChannelHealth["lastKnown"] = {};
  for (const f of SIGNAL_NAMES) {
    const s = toSignal(read.fields[f], f, { provider: read.provider, now: opts.now });
    signals[f] = s;
    if (s.value === UNKNOWN && KEEPS_LAST.has(s.error)) {
      const prev = previous?.[f];
      if (prev && prev.value !== UNKNOWN && prev.checkedAt) lastKnown[f] = { value: prev.value, checkedAt: prev.checkedAt };
      else if (previous?.lastKnown?.[f]) lastKnown[f] = previous.lastKnown[f];
    }
  }
  const at = opts.now.toISOString();
  const templates: TemplatesSignal =
    "error" in read.templates
      ? { value: UNKNOWN, checkedAt: read.templates.error === "unsupported" ? null : at, error: read.templates.error }
      : { value: summarizeTemplates(read.templates.items, { truncated: read.templates.truncated }), checkedAt: at, error: null };
  const base = { ...signals, templates };
  const issues = computeIssues(base);
  return {
    v: 1,
    provider: read.provider,
    checkedAt: at,
    trigger: opts.trigger,
    overall: computeOverall(base, issues),
    ...signals,
    templates,
    issues,
    lastKnown,
    alerts: previous?.alerts ?? null,
  };
}

/** The DTO view: drops `alerts` and the template items. */
export function publicHealth(health: unknown): ChannelHealthPublic | null {
  const h = asChannelHealth(health);
  if (!h) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { alerts, templates, ...rest } = h;
  const value =
    templates && templates.value !== UNKNOWN && typeof templates.value === "object"
      ? (({ items, ...summary }) => summary)(templates.value)
      : UNKNOWN;
  return {
    ...rest,
    templates: { value, checkedAt: templates?.checkedAt ?? null, error: templates?.error ?? null },
  };
}
