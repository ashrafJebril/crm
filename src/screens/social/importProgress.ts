/**
 * Progress of Zernio's first import of a newly connected account's posts.
 * Zernio exposes no real progress (no total post count for a page), so the
 * bar tracks time against its ~90-minute import window and never claims 100%
 * — it only disappears when the backend stops calling the account "importing".
 */
export interface PlatformImportStatus {
  connected: boolean;
  connectedAt: string | null;
  importing: boolean;
  expectedBy: string | null;
  postCount: number | null;
  lastSync: string | null;
  syncTriggered: boolean;
}

export type ImportStatusResponse = Record<"facebook" | "instagram", PlatformImportStatus>;

/** How often the feed and the status re-poll while an import is running. */
export const IMPORT_POLL_MS = 2 * 60_000;

/** Highest the bar goes before the import is actually over. */
const MAX_PERCENT = 95;

export interface ImportProgress {
  /** 0–95: share of the expected import window that has elapsed. */
  percent: number;
  /** Whole minutes since the account was connected. */
  minutesSinceConnect: number;
  /** Whole minutes until the expected finish; 0 once that has passed. */
  minutesLeft: number;
  /** Whole minutes since Zernio's last sync, or null if unknown. */
  minutesSinceSync: number | null;
  /** The expected finish time has passed and it's still importing. */
  overdue: boolean;
}

export function importProgress(s: PlatformImportStatus | undefined, now: number): ImportProgress | null {
  if (!s?.importing || !s.connectedAt || !s.expectedBy) return null;
  const start = Date.parse(s.connectedAt);
  const end = Date.parse(s.expectedBy);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const elapsed = Math.max(0, now - start);
  const sync = s.lastSync ? Date.parse(s.lastSync) : NaN;
  return {
    percent: Math.min(MAX_PERCENT, Math.round((elapsed / (end - start)) * 100)),
    minutesSinceConnect: Math.floor(elapsed / 60_000),
    minutesLeft: Math.max(0, Math.ceil((end - now) / 60_000)),
    minutesSinceSync: Number.isFinite(sync) ? Math.max(0, Math.floor((now - sync) / 60_000)) : null,
    overdue: now >= end,
  };
}
