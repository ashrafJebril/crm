import {
  UNKNOWN,
  tierCap,
  type AlertSignal,
  type ChannelHealth,
  type HealthAlerts,
} from "./health-model";

/**
 * SP-14 downgrade evaluator (pure). `ChannelHealth.alerts.levels` holds the
 * level last notified per signal:
 *  - a known level worse than the stored one is a change (notify once) and
 *    raises the stored level;
 *  - a better level lowers it silently (re-arms, so a later drop notifies);
 *  - unknown neither raises nor lowers it;
 *  - the first check of a number (no stored alerts) is a silent baseline, and
 *    so is the first known value of a signal that had none (ruling 8).
 */

export const ALERT_SIGNALS: readonly AlertSignal[] = [
  "quality",
  "messaging",
  "phoneStatus",
  "nameStatus",
  "accountReview",
  "tier",
  "templatesBad",
];

/** Severity per value. Higher is worse, except `tier` (see `alertLevel`). */
export const ALERT_LEVELS = {
  quality: { GREEN: 0, NOT_RATED: 0, YELLOW: 1, RED: 2 } as Record<string, number>,
  messaging: { AVAILABLE: 0, LIMITED: 1, BLOCKED: 2 } as Record<string, number>,
  phoneStatus: {
    CONNECTED: 0,
    FLAGGED: 1,
    RATE_LIMITED: 1,
    RESTRICTED: 2,
    DISCONNECTED: 2,
    BANNED: 2,
    // Final review M4: Meta deleted the number; critical, as the UI shows it.
    DELETED: 2,
  } as Record<string, number>,
  nameStatus: { DECLINED: 2, EXPIRED: 2 } as Record<string, number>,
  accountReview: { REJECTED: 2 } as Record<string, number>,
} as const;

/** JSON has no Infinity: TIER_UNLIMITED is stored as this string. */
export const UNLIMITED_LEVEL = "unlimited";

/**
 * A signal's level for a value, or null when the value is ignored (unknown,
 * TIER_NOT_SET, an unrecognised value of a signal with a closed table).
 *  - quality / messaging: the table; other values null.
 *  - phoneStatus: the table, MESSAGING_LIMIT_* = 1, any other known status 0.
 *  - nameStatus / accountReview: the table, else 0.
 *  - tier: the tier's daily cap (a number), or "unlimited"; lower is worse.
 *  - templatesBad: the paused + disabled count.
 */
export function alertLevel(signal: AlertSignal, value: unknown): number | string | null {
  if (value === undefined || value === null || value === UNKNOWN) return null;
  switch (signal) {
    case "quality":
    case "messaging":
      return typeof value === "string" ? (ALERT_LEVELS[signal][value] ?? null) : null;
    case "phoneStatus":
      if (typeof value !== "string") return null;
      if (value in ALERT_LEVELS.phoneStatus) return ALERT_LEVELS.phoneStatus[value];
      return value.startsWith("MESSAGING_LIMIT") ? 1 : 0;
    case "nameStatus":
    case "accountReview":
      return typeof value === "string" ? (ALERT_LEVELS[signal][value] ?? 0) : null;
    case "tier": {
      const cap = typeof value === "string" ? tierCap(value) : null;
      if (cap === null) return null;
      return cap === Number.POSITIVE_INFINITY ? UNLIMITED_LEVEL : cap;
    }
    case "templatesBad":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }
}

/** `a` is worse than `b`. */
function worse(signal: AlertSignal, a: number | string, b: number | string): boolean {
  if (signal === "tier") {
    const n = (x: number | string) => (x === UNLIMITED_LEVEL ? Number.POSITIVE_INFINITY : Number(x));
    return n(a) < n(b);
  }
  return Number(a) > Number(b);
}

/** The current value of each alert signal in a health snapshot. */
export function alertValue(health: ChannelHealth, signal: AlertSignal): unknown {
  if (signal === "templatesBad") {
    const t = health.templates?.value;
    return t && t !== UNKNOWN ? t.paused + t.disabled : null;
  }
  return health[signal]?.value;
}

export interface AlertChange {
  signal: AlertSignal;
  /** The previously notified level (a number, or "unlimited" for tier). */
  from: number | string;
  /** The new value: the provider value (e.g. "YELLOW", "TIER_2K"), or the
   *  paused + disabled count for templatesBad. */
  to: string | number;
}

export function evaluateAlerts(
  previousAlerts: HealthAlerts | null | undefined,
  health: ChannelHealth,
  now: Date,
): { changes: AlertChange[]; alerts: HealthAlerts } {
  const baseline = !previousAlerts;
  const alerts: HealthAlerts = {
    baselineAt: previousAlerts?.baselineAt ?? now.toISOString(),
    levels: { ...(previousAlerts?.levels ?? {}) },
  };
  const changes: AlertChange[] = [];
  for (const signal of ALERT_SIGNALS) {
    const value = alertValue(health, signal);
    const level = alertLevel(signal, value);
    if (level === null) continue; // unknown: neither raises nor lowers
    const stored = alerts.levels[signal];
    if (baseline || stored === undefined) {
      alerts.levels[signal] = level;
      continue;
    }
    if (worse(signal, level, stored)) changes.push({ signal, from: stored, to: value as string | number });
    alerts.levels[signal] = level; // raise on a drop, lower (re-arm) on a recovery
  }
  return { changes, alerts };
}
