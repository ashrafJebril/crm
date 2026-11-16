/**
 * SP-10 catalog import: fetch ONE public web page (ruling 9). An SSRF guard:
 *
 *  - `https:` only, default port, no credentials in the URL (→ url_invalid);
 *  - every address the host resolves to must be public (no loopback,
 *    private, link-local, CGNAT, multicast, reserved, `::1`, `fc00::/7`,
 *    `fe80::/10`, metadata `169.254.169.254`, IPv4-mapped/NAT64 forms of
 *    those) → url_blocked. The check runs again on each of ≤ 3 redirects;
 *  - DNS rebinding: the connection is pinned to the address that was checked
 *    (the socket's `lookup` returns it), so the host cannot re-resolve to a
 *    private address between the check and the connect;
 *  - `text/html` or `text/plain` only, ≤ 2 MB streamed, 10 s total
 *    → url_fetch_failed.
 *
 * Test override (SP-15 `META_CDN_TEST_BASE` pattern): `CATALOG_FETCH_TEST_BASE`
 * is honoured only when it is exactly `http://127.0.0.1:<port>`; it rewrites
 * `https://<host>/<path>` to `<base>/<host>/<path>` and skips DNS. Anything
 * else in that variable is ignored.
 *
 * Never logs the page, and never logs a URL's query string.
 */
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { CatalogImportFailure } from "./catalog-import-errors";
import { htmlToText, plainText } from "./html-to-text";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const TEST_BASE_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;

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

export function parsePublicUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new CatalogImportFailure("catalog_import.url_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !url.hostname) {
    throw new CatalogImportFailure("catalog_import.url_invalid");
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

function testBase(): string | null {
  const v = process.env.CATALOG_FETCH_TEST_BASE?.trim();
  return v && TEST_BASE_RE.test(v) ? v : null;
}

async function checkedAddress(url: URL, deps: PageFetchDeps): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new CatalogImportFailure("catalog_import.url_blocked");
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new CatalogImportFailure("catalog_import.url_blocked");
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await deps.resolve(host);
  } catch {
    throw new CatalogImportFailure("catalog_import.url_fetch_failed");
  }
  if (!addrs.length) throw new CatalogImportFailure("catalog_import.url_fetch_failed");
  // Every address must be public: a host with one private record is refused.
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new CatalogImportFailure("catalog_import.url_blocked");
  return addrs[0];
}

// ── fetch ───────────────────────────────────────────────────────────────

/** Returns the page as plain text (≤ maxChars). Throws CatalogImportFailure. */
export async function fetchPageText(rawUrl: string, maxChars: number, deps: PageFetchDeps = defaultDeps()): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchLoop(rawUrl, maxChars, deps, controller.signal);
  } catch (e) {
    if (e instanceof CatalogImportFailure) throw e;
    throw new CatalogImportFailure("catalog_import.url_fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLoop(rawUrl: string, maxChars: number, deps: PageFetchDeps, signal: AbortSignal): Promise<string> {
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
    if (signal.aborted) throw new CatalogImportFailure("catalog_import.url_fetch_failed");
    const res = await deps.request({ url: target, pinned, signal });
    if (res.status >= 300 && res.status < 400) {
      res.abort();
      const loc = res.headers["location"];
      if (!loc || hop >= MAX_REDIRECTS) throw new CatalogImportFailure("catalog_import.url_fetch_failed");
      url = parsePublicUrl(loc, url); // https only, re-checked (incl. DNS) on the next hop
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.abort();
      throw new CatalogImportFailure("catalog_import.url_fetch_failed");
    }
    const type = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "text/html" && type !== "text/plain") {
      res.abort();
      throw new CatalogImportFailure("catalog_import.url_fetch_failed");
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
      res.abort();
      throw new CatalogImportFailure("catalog_import.url_fetch_failed");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_PAGE_BYTES) {
        res.abort();
        throw new CatalogImportFailure("catalog_import.url_fetch_failed");
      }
      chunks.push(chunk);
      if (signal.aborted) {
        res.abort();
        throw new CatalogImportFailure("catalog_import.url_fetch_failed");
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return type === "text/html" ? htmlToText(body, maxChars) : plainText(body, maxChars);
  }
}

/** Node's own DNS and http(s), with the socket pinned to the checked address. */
export function defaultDeps(): PageFetchDeps {
  return {
    async resolve(host) {
      const all = await dnsLookup(host, { all: true, verbatim: true });
      return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
    },
    request({ url, pinned, signal }) {
      return new Promise<PageResponse>((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
          url,
          {
            method: "GET",
            signal,
            headers: { accept: "text/html, text/plain;q=0.9", "user-agent": "KewyCRM-CatalogImport/1.0" },
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
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
            resolve({ status: res.statusCode ?? 0, headers, body: res, abort: () => res.destroy() });
          },
        );
        req.on("error", reject);
        req.end();
      });
    },
  };
}
