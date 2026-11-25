import { graphVersion } from "../channels/whatsapp/meta-graph.client";

/** SP-15 Meta Ads settings, from env only (nothing is invented). */
type Env = Record<string, string | undefined>;

const read = (env: Env, k: string) => (env[k] ?? "").trim();

export interface MetaAdsApp {
  appId: string;
  appSecret: string;
  configId: string;
  /** `META_ADS_GRAPH_VERSION` when valid, else `graphVersion()` (ruling 12). */
  graphVersion: string;
  /** Env names still unset (never their values). */
  missing: string[];
}

/**
 * The Meta app used for Meta Ads (ruling 11/12). `META_ADS_APP_ID` /
 * `META_ADS_APP_SECRET` fall back to `META_APP_ID` / `META_APP_SECRET` when one
 * app serves both. `META_ADS_LOGIN_CONFIG_ID` is the Login for Business
 * configuration. The secret never leaves the backend.
 */
export function metaAdsApp(env: Env = process.env): MetaAdsApp {
  const appId = read(env, "META_ADS_APP_ID") || read(env, "META_APP_ID");
  const appSecret = read(env, "META_ADS_APP_SECRET") || read(env, "META_APP_SECRET");
  const configId = read(env, "META_ADS_LOGIN_CONFIG_ID");
  const v = read(env, "META_ADS_GRAPH_VERSION");
  const missing: string[] = [];
  if (!appId) missing.push("META_ADS_APP_ID");
  if (!appSecret) missing.push("META_ADS_APP_SECRET");
  if (!configId) missing.push("META_ADS_LOGIN_CONFIG_ID");
  return {
    appId,
    appSecret,
    configId,
    graphVersion: /^v\d{1,3}\.\d{1,3}$/.test(v) ? v : graphVersion(env),
    missing,
  };
}

/** The OAuth redirect URI registered on the Meta app. */
export function redirectUri(env: Env = process.env): string {
  const base = (read(env, "BACKEND_PUBLIC_URL") || "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/api/meta-ads/oauth/callback`;
}

/** Where the OAuth callback sends the browser back to. */
export function frontendConnectionUrl(params: Record<string, string>, env: Env = process.env): string {
  const base = (read(env, "FRONTEND_PUBLIC_URL") || "http://localhost:5173").replace(/\/+$/, "");
  const qs = new URLSearchParams({ tab: "connection", ...params }).toString();
  return `${base}/#/ads?${qs}`;
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** Connections synced per hourly tick. */
export const META_ADS_SYNC_BATCH = 20;
/** A connection is due once its last attempt is this old. */
export const META_ADS_SYNC_INTERVAL_MS = 55 * 60_000;
/** A tick starts no new connection after this long. */
export const META_ADS_SYNC_MAX_MS = 10 * 60_000;
/** Insights pages read per connection per run. */
export const META_ADS_MAX_PAGES = 40;
/** One live check per workspace per this long (DB-backed). */
export const META_ADS_CHECK_COOLDOWN_MS = 60_000;
/** First sync: days of spend read. */
export const BACKFILL_DAYS = 90;
/** First sync: days per insights window. */
export const WINDOW_DAYS = 7;
/** Later syncs: Meta restates recent days, so the last 3 are re-read. */
export const RECENT_DAYS = 3;

export const syncBatch = (env: Env = process.env) => positiveInt(env.META_ADS_SYNC_BATCH, META_ADS_SYNC_BATCH);
export const syncIntervalMs = (env: Env = process.env) => positiveInt(env.META_ADS_SYNC_INTERVAL_MS, META_ADS_SYNC_INTERVAL_MS);
export const syncMaxMs = (env: Env = process.env) => positiveInt(env.META_ADS_SYNC_MAX_MS, META_ADS_SYNC_MAX_MS);
export const maxPages = (env: Env = process.env) => positiveInt(env.META_ADS_MAX_PAGES, META_ADS_MAX_PAGES);
