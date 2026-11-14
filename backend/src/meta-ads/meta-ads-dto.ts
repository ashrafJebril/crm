import type { MetaAdsConnection } from "@prisma/client";
import { metaAdsApp } from "./meta-ads.config";
import { metaAdsEncryptionAvailable } from "./meta-ads-token";

export type MetaAdsStatus = "not_connected" | "pending" | "active" | "needs_reconnect" | "disconnected";

/** `GET /meta-ads/connection` (and every write's reply). Never holds a token. */
export interface MetaAdsConnectionDto {
  status: MetaAdsStatus;
  statusReason: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  currency: string | null;
  timezone: string | null;
  pageId: string | null;
  pageName: string | null;
  connectedAt: Date | null;
  connectedBy: { id: string; name: string } | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  spendBackfilled: boolean;
  tokenExpiresAt: Date | null;
  hasPendingLogin: boolean;
  config: { ready: boolean; missing?: string[] };
}

const STATUSES = new Set(["pending", "active", "needs_reconnect", "disconnected"]);

/** Whether connecting can work here: app settings present and, in production, `TOKEN_ENC_KEY`. */
export function metaAdsConfigState(): { ready: boolean; missing: string[] } {
  const missing = [...metaAdsApp().missing];
  if (!metaAdsEncryptionAvailable()) missing.push("TOKEN_ENC_KEY");
  return { ready: missing.length === 0, missing };
}

/**
 * The connection row → its DTO. Token columns are never read here.
 * `missing` (env names) is shown only to `connectors.manage` holders.
 */
export function toMetaAdsDto(
  row: Partial<MetaAdsConnection> | null | undefined,
  viewerCanManage: boolean,
  connectedBy: { id: string; name: string } | null = null,
  now: Date = new Date(),
): MetaAdsConnectionDto {
  const cfg = metaAdsConfigState();
  const config = { ready: cfg.ready, ...(viewerCanManage && cfg.missing.length ? { missing: cfg.missing } : {}) };
  if (!row) {
    return {
      status: "not_connected",
      statusReason: null,
      adAccountId: null,
      adAccountName: null,
      currency: null,
      timezone: null,
      pageId: null,
      pageName: null,
      connectedAt: null,
      connectedBy: null,
      lastSyncedAt: null,
      lastSyncError: null,
      spendBackfilled: false,
      tokenExpiresAt: null,
      hasPendingLogin: false,
      config,
    };
  }
  return {
    status: STATUSES.has(String(row.status)) ? (row.status as MetaAdsStatus) : "not_connected",
    statusReason: row.statusReason ?? null,
    adAccountId: row.adAccountId ?? null,
    adAccountName: row.adAccountName ?? null,
    currency: row.currency ?? null,
    timezone: row.timezone ?? null,
    pageId: row.pageId ?? null,
    pageName: row.pageName ?? null,
    connectedAt: row.connectedAt ?? null,
    connectedBy,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastSyncError: row.lastSyncError ?? null,
    spendBackfilled: !!row.spendBackfilledAt,
    tokenExpiresAt: row.tokenExpiresAt ?? null,
    // A pending login past its choose-step deadline can no longer be used (M1).
    hasPendingLogin: !!row.pendingTokenEnc && !!row.pendingExpiresAt && row.pendingExpiresAt.getTime() > now.getTime(),
    config,
  };
}
