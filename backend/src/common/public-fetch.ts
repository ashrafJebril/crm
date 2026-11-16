/**
 * Fetch public web resources safely (moved from SP-10's
 * `catalog-import/fetch-page.ts` for SP-21; the policy is unchanged). An SSRF
 * guard shared by the catalog import and the knowledge crawler:
 *
 *  - `https:` only, default port, no credentials in the URL (→ url_invalid);
 *  - every address the host resolves to must be public (no loopback,
 *    private, link-local, CGNAT, multicast, reserved, `::1`, `fc00::/7`,
 *    `fe80::/10`, metadata `169.254.169.254`, IPv4-mapped/NAT64 forms of
 *    those) → url_blocked. The check runs again on each of ≤ 3 redirects;
 *  - DNS rebinding: the connection is pinned to the address that was checked
 *    (the socket's `lookup` returns it), so the host cannot re-resolve to a
 *    private address between the check and the connect;
 *  - only the caller's accepted content types, ≤ `maxBytes` streamed, a total
 *    timeout → unsupported_type / too_large / timeout / fetch_failed.
 *
 * Redirects: by default every hop is followed (after its checks). A caller
 * may pass `followRedirect(from, to)`; when it returns false the result
 * carries `redirectRefused: to` and the target is never requested (the
 * crawler refuses to leave the site's origin).
 *
 * Test override (SP-15 `META_CDN_TEST_BASE` pattern): `PUBLIC_FETCH_TEST_BASE`
 * (or its SP-10 alias `CATALOG_FETCH_TEST_BASE`) is honoured only when it is
 * exactly `http://127.0.0.1:<port>`; it rewrites `https://<host>/<path>` to
 * `<base>/<host>/<path>` and skips DNS. Anything else in it is ignored.
 *
 * Never logs the page, and never logs a URL's query string.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const TEST_BASE_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

export type PublicFetchCode = "url_invalid" | "url_blocked" | "fetch_failed" | "unsupported_type" | "too_large" | "timeout";

/** A typed refusal; callers map it to their own error keys. */
export class PublicFetchError extends Error {
  constructor(public readonly code: PublicFetchCode) {
    super(code);
    this.name = "PublicFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Buffer>;
  /** Stops reading (and closes the socket). */
  abort(): void;
}

export interface PageRequest {
  url: URL;
  /** The checked address the socket must connect to (null in test-base mode). */
  pinned: ResolvedAddress | null;
  signal: AbortSignal;
  /** Request headers (accept, user-agent). */
  headers?: Record<string, string>;
}

export interface PageFetchDeps {
  resolve(host: string): Promise<ResolvedAddress[]>;
  request(req: PageRequest): Promise<PageResponse>;
  now?(): number;
}

// ── address policy ──────────────────────────────────────────────────────

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible ::a.b.c.d / ::7f00:1 (deprecated; review M1)
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215): translation depends on the host's network
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001::", 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ["2002::", 16], // 6to4 can embed any IPv4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/**
 * IPv4 embedded in an IPv6 address (mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`).
 * The IPv4-compatible `::/96` is not decoded: it is blocked whole (review M1).
 */
function embeddedV4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0];
  const kind = isIP(bare);
  if (kind === 4) return !BLOCKED.check(bare, "ipv4");
  if (kind === 6) {
    const v4 = embeddedV4(bare);
    if (v4) return isIP(v4) === 4 && !BLOCKED.check(v4, "ipv4");
    if (/^::ffff:/i.test(bare) || /^64:ff9b::/i.test(bare)) return false; // unparsed embedded forms
    return !BLOCKED.check(bare, "ipv6");
  }
  return false;
}

// ── URL policy ──────────────────────────────────────────────────────────

/** An `https:` URL on the default port without credentials; else PublicFetchError("url_invalid"). */
export function parsePublicUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new PublicFetchError("url_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !url.hostname) {
    throw new PublicFetchError("url_invalid");
  }
  return url;
}

/** For logs: scheme, host and path only (never the query or fragment). */
export function redactedUrl(url: URL | string): string {
  try {
    const u = typeof url === "string" ? new URL(url) : url;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "[invalid url]";
  }
}

/** The loopback test base, when set and valid (PUBLIC_FETCH_TEST_BASE, alias CATALOG_FETCH_TEST_BASE). */
export function testBase(): string | null {
  for (const name of ["PUBLIC_FETCH_TEST_BASE", "CATALOG_FETCH_TEST_BASE"]) {
    const v = process.env[name]?.trim();
    if (v) return TEST_BASE_RE.test(v) ? v : null;
  }
  return null;
}

/** The public address a URL's host resolves to (every address must be public). */
export async function checkedAddress(url: URL, deps: PageFetchDeps): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new PublicFetchError("url_blocked");
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new PublicFetchError("url_blocked");
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await deps.resolve(host);
  } catch {
    throw new PublicFetchError("fetch_failed");
  }
  if (!addrs.length) throw new PublicFetchError("fetch_failed");
  // Every address must be public: a host with one private record is refused.
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new PublicFetchError("url_blocked");
  return addrs[0];
}

// ── fetch ───────────────────────────────────────────────────────────────

export interface PublicFetchOptions {
  /** Accepted content types (lower-case, no parameters). */
  accept: string[];
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Called for each redirect (after the URL policy); false stops before requesting the target. */
  followRedirect?: (from: URL, to: URL) => boolean;
  /** Return non-2xx responses (without a body) instead of failing. */
  returnErrorStatus?: boolean;
}

export interface PublicFetchResult {
  /** The URL that answered (after redirects). */
  url: URL;
  status: number;
  contentType: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** UTF-8 body of a 2xx response; "" otherwise. */
  body: string;
  /** Set when `followRedirect` refused a hop: the target that was not requested. */
  redirectRefused?: URL;
}

/** One public resource. Throws PublicFetchError. */
export async function fetchPublic(rawUrl: string, opts: PublicFetchOptions, deps: PageFetchDeps = defaultDeps()): Promise<PublicFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await fetchLoop(rawUrl, opts, deps, controller.signal);
  } catch (e) {
    if (timedOut) throw new PublicFetchError("timeout");
    if (e instanceof PublicFetchError) throw e;
    throw new PublicFetchError("fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoop(rawUrl: string, opts: PublicFetchOptions, deps: PageFetchDeps, signal: AbortSignal): Promise<PublicFetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_PAGE_BYTES;
  const headers = {
    accept: opts.accept.join(", "),
    "user-agent": opts.userAgent ?? "KewyCRM-CatalogImport/1.0",
  };
  let url = parsePublicUrl(rawUrl);
  const base = testBase();
  for (let hop = 0; ; hop++) {
    let target = url;
    let pinned: ResolvedAddress | null = null;
    if (base) {
      target = new URL(`${base}/${url.hostname}${url.pathname}${url.search}`);
    } else {
      pinned = await checkedAddress(url, deps);
    }
    if (signal.aborted) throw new PublicFetchError("fetch_failed");
    const res = await deps.request({ url: target, pinned, signal, headers });
    const lower: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) lower[k.toLowerCase()] = v;
    if (res.status >= 300 && res.status < 400) {
      res.abort();
      const loc = lower["location"];
      if (!loc || hop >= MAX_REDIRECTS) throw new PublicFetchError("fetch_failed");
      const next = parsePublicUrl(loc, url); // https only, re-checked (incl. DNS) on the next hop
      if (opts.followRedirect && !opts.followRedirect(url, next)) {
        return { url, status: res.status, contentType: "", headers: lower, body: "", redirectRefused: next };
      }
      url = next;
      continue;
    }
    const type = (lower["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (res.status < 200 || res.status >= 300) {
      res.abort();
      if (opts.returnErrorStatus) return { url, status: res.status, contentType: type, headers: lower, body: "" };
      throw new PublicFetchError("fetch_failed");
    }
    if (!opts.accept.includes(type)) {
      res.abort();
      throw new PublicFetchError("unsupported_type");
    }
    const declared = Number(lower["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.abort();
      throw new PublicFetchError("too_large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) {
        res.abort();
        throw new PublicFetchError("too_large");
      }
      chunks.push(chunk);
      if (signal.aborted) {
        res.abort();
        throw new PublicFetchError("fetch_failed");
      }
    }
    return { url, status: res.status, contentType: type, headers: lower, body: Buffer.concat(chunks).toString("utf8") };
  }
}

/** Node's own DNS and http(s), with the socket pinned to the checked address. */
export function defaultDeps(): PageFetchDeps {
  return {
    async resolve(host) {
      const all = await dnsLookup(host, { all: true, verbatim: true });
      return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
    },
    request({ url, pinned, signal, headers }) {
      return new Promise<PageResponse>((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
          url,
          {
            method: "GET",
            signal,
            headers: headers ?? { accept: "text/html, text/plain;q=0.9", "user-agent": "KewyCRM-CatalogImport/1.0" },
            // The connection goes to the address we checked; TLS still verifies the host name.
            ...(pinned
              ? {
                  // Node may ask for `all` addresses (autoSelectFamily); answer both shapes.
                  lookup: (_h: string, o: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) =>
                    o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family),
                }
              : {}),
          } as https.RequestOptions,
          (res) => {
            const out: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(", ") : v;
            resolve({ status: res.statusCode ?? 0, headers: out, body: res, abort: () => res.destroy() });
          },
        );
        req.on("error", reject);
        req.end();
      });
    },
  };
}
