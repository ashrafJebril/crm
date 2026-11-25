/**
 * Whether Zernio is still backfilling a newly connected account's existing
 * posts, and how far along that is.
 *
 * Zernio exposes no import progress and no "posts on the page" total (the
 * spike-era `externalPostCount` is gone from /accounts), so progress is
 * measured against time: Zernio's external-post sync runs roughly every
 * 90 minutes, so a fresh account is expected to have its history by then.
 * Past IMPORT_GIVE_UP_MS we stop calling it "importing" — an empty feed that
 * late means the page has no posts in the window, or Zernio has a problem,
 * and a banner promising an import would be a lie.
 */
export const IMPORT_EXPECTED_MS = 90 * 60_000;
export const IMPORT_GIVE_UP_MS = 3 * 60 * 60_000;

export interface PlatformImportStatus {
  connected: boolean;
  /** When the account was connected to Zernio (ISO), if known. */
  connectedAt: string | null;
  /** True while the first backfill is plausibly still running. */
  importing: boolean;
  /** When the first backfill should be done (ISO); null when not importing. */
  expectedBy: string | null;
  /** Posts Zernio has imported so far in the feed window. */
  postCount: number | null;
  /** Zernio's last external sync for the profile (ISO). */
  lastSync: string | null;
  /** Zernio started a sync because of this status request. */
  syncTriggered: boolean;
}

export function importStatus(input: {
  connectedAt: string | null | undefined;
  postCount: number | null;
  lastSync: string | null | undefined;
  syncTriggered: boolean | undefined;
  now: number;
}): PlatformImportStatus {
  const connectedMs = input.connectedAt ? Date.parse(input.connectedAt) : NaN;
  const known = Number.isFinite(connectedMs);
  const age = known ? input.now - connectedMs : Infinity;
  const importing = known && age >= 0 && age < IMPORT_GIVE_UP_MS;
  return {
    connected: true,
    connectedAt: known ? new Date(connectedMs).toISOString() : null,
    importing,
    expectedBy: importing ? new Date(connectedMs + IMPORT_EXPECTED_MS).toISOString() : null,
    postCount: input.postCount,
    lastSync: input.lastSync ?? null,
    syncTriggered: input.syncTriggered === true,
  };
}

export const NOT_CONNECTED: PlatformImportStatus = {
  connected: false,
  connectedAt: null,
  importing: false,
  expectedBy: null,
  postCount: null,
  lastSync: null,
  syncTriggered: false,
};
