/**
 * Spec-only fake of Meta's Graph API for the SP-19 T4 specs (not a runtime
 * file; same convention as ../test-prisma.ts). It is passed to
 * `MetaGraphClient` as its injected `fetch`, so no spec ever reaches Meta.
 *
 * Handlers are matched in order against `"<METHOD> <url>"` (substring or
 * RegExp). An unmatched call throws, so a spec fails loudly on any Graph call
 * it did not expect.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GraphReply {
  status?: number;
  body: unknown;
}
export type GraphHandler = [string | RegExp, GraphReply | ((url: string, init: RequestInit) => GraphReply)];

export interface GraphCall {
  method: string;
  url: string;
  body: any;
  headers: Record<string, string>;
}

export function fakeGraph(handlers: GraphHandler[] = []) {
  const calls: GraphCall[] = [];
  const list = [...handlers];
  const fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    let body: any;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
    for (const [pat, reply] of list) {
      if (typeof pat === "string" ? key.includes(pat) : pat.test(key)) {
        const r = typeof reply === "function" ? reply(url, init) : reply;
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`unmocked Graph call: ${key}`);
  });
  return {
    fetch,
    calls,
    /** Add handlers that take precedence over the existing ones. */
    prepend: (...h: GraphHandler[]) => list.unshift(...h),
    called: (pat: string | RegExp) =>
      calls.filter((c) => (typeof pat === "string" ? `${c.method} ${c.url}`.includes(pat) : pat.test(`${c.method} ${c.url}`))),
  };
}

/** A Graph error body, e.g. `graphError(136025)`. */
export function graphError(code: number, message = "Graph refused", status = 400): GraphReply {
  return { status, body: { error: { message, type: "OAuthException", code } } };
}

/** The Meta app env the embedded signup needs, set for the duration of a spec. */
export const META_ENV = {
  META_APP_ID_WA: "1234567890",
  META_APP_SECRET_WA: "APP-SECRET-xyz-987",
  META_WA_CONFIG_ID: "555000111",
} as const;

const KEYS = [
  "META_APP_ID_WA",
  "META_APP_ID",
  "META_APP_SECRET_WA",
  "META_APP_SECRET",
  "META_WA_CONFIG_ID",
  "META_WA_SOLUTION_ID",
  "META_GRAPH_VERSION",
  "META_GRAPH_BASE_URL",
  "CHANNEL_WHATSAPP_LIMIT",
  "TOKEN_ENC_KEY",
  "NODE_ENV",
  // SP-15 Meta Ads
  "META_ADS_APP_ID",
  "META_ADS_APP_SECRET",
  "META_ADS_LOGIN_CONFIG_ID",
  "META_ADS_GRAPH_VERSION",
  "META_ADS_SYNC_BATCH",
  "META_ADS_SYNC_INTERVAL_MS",
  "META_ADS_SYNC_MAX_MS",
  "META_ADS_MAX_PAGES",
] as const;

/** Snapshot the env keys these specs touch; returns a restore function. */
export function isolateEnv(set: Partial<Record<(typeof KEYS)[number], string>> = {}): () => void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) if (k !== "NODE_ENV") delete process.env[k];
  Object.assign(process.env, set);
  return () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// ─── SP-15: Marketing API routes (Meta Ads connect and the spend sync) ─────

/** The Meta Ads app env, set for the duration of a spec. */
export const META_ADS_ENV = {
  META_ADS_APP_ID: "777000111",
  META_ADS_APP_SECRET: "ADS-APP-SECRET-abc-123",
  META_ADS_LOGIN_CONFIG_ID: "888000222",
  META_ADS_GRAPH_VERSION: "v23.0",
} as const;

/** The token the fake OAuth exchange hands out. */
export const ADS_TOKEN = "EAAB-ads-token-SECRET-0123456789";

/** A Graph insights row. */
export function insightRow(adId: string, date: string, spend: string, names: Partial<Record<"ad_name" | "adset_name" | "campaign_name", string>> = {}) {
  return { ad_id: adId, date_start: date, date_stop: date, spend, ...names };
}

/**
 * Default Marketing API replies: the code exchange, `ads_read` granted, two
 * ad accounts (act_111 USD Asia/Riyadh, act_222 EUR UTC), one Page (900), `/me`,
 * the ad account read and empty insights. Prepend handlers to override.
 */
export function marketingHandlers(opts: { token?: string; scopes?: string[] } = {}): GraphHandler[] {
  const scopes = opts.scopes ?? ["ads_read", "business_management", "pages_show_list"];
  return [
    ["/oauth/access_token", { body: { access_token: opts.token ?? ADS_TOKEN, token_type: "bearer" } }],
    ["/me/permissions", { body: { data: scopes.map((permission) => ({ permission, status: "granted" })) } }],
    [
      "/me/adaccounts",
      {
        body: {
          data: [
            { id: "act_111", name: "Main account", currency: "USD", timezone_name: "Asia/Riyadh", account_status: 1 },
            { id: "act_222", name: "Second account", currency: "EUR", timezone_name: "UTC", account_status: 1 },
          ],
        },
      },
    ],
    ["/me/accounts", { body: { data: [{ id: "900", name: "Shop page" }] } }],
    // A system-user token: valid, never expires (expires_at 0).
    ["/debug_token", { body: { data: { is_valid: true, expires_at: 0 } } }],
    [/\/me\?/, { body: { id: "user-1" } }],
    [/\/act_\d+\/insights/, { body: { data: [] } }],
    [/\/act_\d+\?/, { body: { id: "act_111", name: "Main account", currency: "USD", timezone_name: "Asia/Riyadh", account_status: 1 } }],
  ];
}
