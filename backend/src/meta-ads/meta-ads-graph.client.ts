import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { META_GRAPH_FETCH, metaGraphBase, type FetchLike } from "../channels/whatsapp/meta-graph.client";
import { metaAdsApp } from "./meta-ads.config";

const TIMEOUT_MS = 15_000;

export type GraphErrorKind = "token" | "rate_limit" | "refused" | "transient" | "permanent";

const TOKEN_CODES = new Set([190, 102, 463, 467]);
const RATE_CODES = new Set([4, 17, 32, 613]);
/** Graph 100 subcodes that mean "the object does not exist or you may not see it". */
const ASSET_SUBCODES = new Set([33]);

/**
 * Pure classification of a Graph failure (Architecture → Spend sync → Errors).
 * `status` 0 is a network failure or a timeout.
 */
export function classifyGraphError(code: number | null, subcode: number | null, status: number): GraphErrorKind {
  if (code !== null && TOKEN_CODES.has(code)) return "token";
  if (subcode !== null && TOKEN_CODES.has(subcode) && code === 190) return "token";
  if (status === 429 || (code !== null && (RATE_CODES.has(code) || (code >= 80000 && code <= 80014)))) return "rate_limit";
  if (code !== null && (code === 10 || (code >= 200 && code <= 299))) return "refused";
  if (code === 100 && subcode !== null && ASSET_SUBCODES.has(subcode)) return "refused";
  if (status === 0 || status >= 500 || code === 1 || code === 2) return "transient";
  return "permanent";
}

/**
 * A failed Marketing/Graph call. It keeps only Graph's numeric code, subcode,
 * the HTTP status and `fbtrace_id`; Meta's message text (which may echo a URL
 * or a token) is never kept, so `message` is a fixed string.
 */
export class MetaAdsGraphError extends Error {
  readonly kind: GraphErrorKind;
  constructor(
    readonly code: number | null,
    readonly subcode: number | null,
    readonly httpStatus: number,
    readonly fbtraceId: string | null,
  ) {
    super(`meta_graph_error status=${httpStatus} code=${code ?? "-"}`);
    this.name = "MetaAdsGraphError";
    this.kind = classifyGraphError(code, subcode, httpStatus);
  }
}

export interface AdAccountRow {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  accountStatus: number | null;
}
export interface PageRow {
  id: string;
  name: string | null;
}
export interface InsightRow {
  ad_id?: string;
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
  spend?: string;
  date_start?: string;
}
export interface TokenGrant {
  token: string;
  /** Seconds; null when Meta sent none (a non-expiring system-user token). */
  expiresIn: number | null;
}

/** The insights fields (ruling 12: never `actions`). */
export const INSIGHTS_FIELDS = "ad_id,ad_name,adset_name,campaign_name,spend,date_start";

interface CallOptions {
  token?: string;
  query?: Record<string, string>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `appsecret_proof`: HMAC-SHA256 of the token keyed with the app secret. */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

/**
 * SP-15: the one place Meta Ads talks to Graph. Every call:
 *  - goes to `metaGraphBase()` (graph.facebook.com or loopback only) at
 *    `META_ADS_GRAPH_VERSION`;
 *  - sends the token in `Authorization: Bearer` plus `appsecret_proof`;
 *  - has a 15 s timeout and is never retried;
 *  - logs only the method, the path (no query) and the numeric error code.
 */
@Injectable()
export class MetaAdsGraphClient {
  private readonly log = new Logger(MetaAdsGraphClient.name);

  constructor(@Optional() @Inject(META_GRAPH_FETCH) private readonly fetchImpl?: FetchLike) {}

  /** OAuth `code` → token (Login for Business). */
  async exchangeCode(code: string, redirect: string): Promise<TokenGrant> {
    const app = metaAdsApp();
    const res = await this.call<{ access_token?: unknown; expires_in?: unknown }>("/oauth/access_token", {
      query: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirect, code },
    });
    const token = str(res?.access_token);
    if (!token) throw new MetaAdsGraphError(null, null, 502, null);
    return { token, expiresIn: num(res?.expires_in) };
  }

  /** A short user token → a long-lived one (only for a user-token configuration). */
  async exchangeLongLived(token: string): Promise<TokenGrant> {
    const app = metaAdsApp();
    const res = await this.call<{ access_token?: unknown; expires_in?: unknown }>("/oauth/access_token", {
      query: { grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: token },
    });
    const next = str(res?.access_token);
    if (!next) throw new MetaAdsGraphError(null, null, 502, null);
    return { token: next, expiresIn: num(res?.expires_in) };
  }

  async me(token: string): Promise<{ id: string | null }> {
    const res = await this.call<{ id?: unknown }>("/me", { token, query: { fields: "id" } });
    return { id: str(res?.id) };
  }

  /** Granted permission names. */
  async permissions(token: string): Promise<string[]> {
    const res = await this.call<{ data?: Array<{ permission?: unknown; status?: unknown }> }>("/me/permissions", { token });
    return (Array.isArray(res?.data) ? res!.data : [])
      .filter((p) => p?.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string);
  }

  /** Ad accounts the token reaches (first 100). */
  async adAccounts(token: string): Promise<AdAccountRow[]> {
    const res = await this.call<{ data?: unknown[] }>("/me/adaccounts", {
      token,
      query: { fields: "id,name,currency,timezone_name,account_status", limit: "100" },
    });
    return (Array.isArray(res?.data) ? res!.data : []).flatMap((r) => {
      const a = toAccount(r);
      return a ? [a] : [];
    });
  }

  /** Pages the token reaches (first 100). */
  async pages(token: string): Promise<PageRow[]> {
    const res = await this.call<{ data?: Array<{ id?: unknown; name?: unknown }> }>("/me/accounts", {
      token,
      query: { fields: "id,name", limit: "100" },
    });
    return (Array.isArray(res?.data) ? res!.data : []).flatMap((p) => {
      const id = str(p?.id);
      return id && /^\d{1,32}$/.test(id) ? [{ id, name: str(p?.name) }] : [];
    });
  }

  async adAccount(act: string, token: string): Promise<AdAccountRow> {
    const res = await this.call<unknown>(`/${seg(act)}`, {
      token,
      query: { fields: "id,name,currency,timezone_name,account_status" },
    });
    const a = toAccount(res);
    if (!a) throw new MetaAdsGraphError(null, null, 502, null);
    return a;
  }

  /** One page of daily ad-level spend. `after` is null on the last page. */
  async insights(
    act: string,
    token: string,
    q: { since: string; until: string; after?: string | null },
  ): Promise<{ data: InsightRow[]; after: string | null }> {
    const res = await this.call<{ data?: unknown; paging?: { next?: unknown; cursors?: { after?: unknown } } }>(
      `/${seg(act)}/insights`,
      {
        token,
        query: {
          level: "ad",
          time_increment: "1",
          fields: INSIGHTS_FIELDS,
          time_range: JSON.stringify({ since: q.since, until: q.until }),
          limit: "500",
          ...(q.after ? { after: q.after } : {}),
        },
      },
    );
    const data = Array.isArray(res?.data) ? (res!.data as InsightRow[]) : [];
    const after = res?.paging?.next && str(res.paging.cursors?.after) ? str(res.paging.cursors?.after) : null;
    return { data, after };
  }

  private async call<T>(path: string, opts: CallOptions = {}): Promise<T> {
    const app = metaAdsApp();
    const url = new URL(`${metaGraphBase()}/${app.graphVersion}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (opts.token) {
      headers.Authorization = `Bearer ${opts.token}`;
      if (app.appSecret) url.searchParams.set("appsecret_proof", appSecretProof(opts.token, app.appSecret));
    }
    const doFetch: FetchLike = this.fetchImpl ?? ((u, i) => fetch(u, i));
    let res: Response;
    try {
      res = await doFetch(url.toString(), { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError";
      this.log.warn(`meta ads graph GET ${path} failed: ${timeout ? "timeout" : "network_error"}`);
      throw new MetaAdsGraphError(null, null, 0, null);
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = (parsed as { error?: { code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } } | undefined)?.error;
      const code = num(err?.code);
      const subcode = num(err?.error_subcode);
      const trace = typeof err?.fbtrace_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(err.fbtrace_id) ? err.fbtrace_id : null;
      const e = new MetaAdsGraphError(code, subcode, res.status, trace);
      this.log.warn(`meta ads graph GET ${path} -> ${res.status} code=${code ?? "-"} subcode=${subcode ?? "-"} kind=${e.kind} trace=${trace ?? "-"}`);
      throw e;
    }
    return parsed as T;
  }
}

function toAccount(r: unknown): AdAccountRow | null {
  const o = (r ?? {}) as Record<string, unknown>;
  const id = str(o.id);
  if (!id || !/^act_\d{1,32}$/.test(id)) return null;
  return {
    id,
    name: str(o.name),
    currency: typeof o.currency === "string" && /^[A-Z]{3}$/.test(o.currency) ? o.currency : null,
    timezone: str(o.timezone_name),
    accountStatus: num(o.account_status),
  };
}

/** A Graph id as one path segment (never walks to another edge). */
function seg(id: string): string {
  return encodeURIComponent(String(id));
}
