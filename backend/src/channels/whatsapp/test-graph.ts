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
