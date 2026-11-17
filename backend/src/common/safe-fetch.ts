/**
 * SP-27: outbound POSTs to customer-chosen URLs (webhooks; SP-23 connectors
 * reuse it). Built on the SSRF policy of `public-fetch.ts`:
 *
 *  - `https:` only, port 443 or 8443, no credentials in the URL;
 *  - every address the host resolves to must be public (`isPublicAddress`:
 *    loopback, RFC 1918, link-local, CGNAT, metadata, IPv6 ULA/link-local and
 *    IPv4-mapped forms are refused) → UnsafeUrlError;
 *  - the socket is pinned to the checked address (DNS rebinding);
 *  - redirects are never followed: a 3xx is a failed delivery;
 *  - the response body is read to at most RESPONSE_READ_BYTES and dropped;
 *  - a total timeout.
 *
 * Test-only loopback escape (ruling 5): `WEBHOOK_TEST_LOOPBACK=zz-verify`,
 * honoured only when FLY_APP_NAME is unset AND NODE_ENV is not production,
 * permits `http://127.0.0.1:<port>`. Anything else (another value, on Fly,
 * in production) leaves the escape off.
 *
 * Never logs the body, the headers or a URL's query string.
 */
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { isPublicAddress, redactedUrl, type ResolvedAddress } from "./public-fetch";

export const SAFE_FETCH_TIMEOUT_MS = 10_000;
export const RESPONSE_READ_BYTES = 2 * 1024;
const ALLOWED_PORTS = new Set(["", "443", "8443"]);
const LOOPBACK_RE = /^http:\/\/127\.0\.0\.1:\d{2,5}(\/|$)/;
export const LOOPBACK_FLAG = "zz-verify";

/** The URL may never be used (scheme, port, credentials or a private address). */
export class UnsafeUrlError extends Error {
  constructor(public readonly reason: "invalid" | "blocked") {
    super(`unsafe_url:${reason}`);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeRequest {
  url: URL;
  /** The checked address the socket must connect to (null for the loopback escape). */
  pinned: ResolvedAddress | null;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

export interface SafeResponse {
  status: number;
}

export interface SafeFetchDeps {
  resolve(host: string): Promise<ResolvedAddress[]>;
  request(req: SafeRequest): Promise<SafeResponse>;
}

export interface SafeFetchResult {
  /** Response status, or 0 when no response arrived (network error, timeout). */
  status: number;
  ok: boolean;
  /** Short, safe reason for the log ("timeout", "network_error", "redirect", "http_500"). */
  error: string | null;
}

/** Ruling 5: the loopback escape, only off Fly and outside production. */
export function loopbackEscapeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WEBHOOK_TEST_LOOPBACK === LOOPBACK_FLAG && !env.FLY_APP_NAME && env.NODE_ENV !== "production";
}

function isLoopbackUrl(raw: string): boolean {
  return LOOPBACK_RE.test(raw);
}

/** URL policy alone (create time): throws UnsafeUrlError. */
export function parseSafeUrl(raw: string, env: NodeJS.ProcessEnv = process.env): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new UnsafeUrlError("invalid");
  if (isLoopbackUrl(raw)) {
    if (!loopbackEscapeAllowed(env)) throw new UnsafeUrlError("blocked");
    return new URL(raw);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || !ALLOWED_PORTS.has(url.port) || url.hash) {
    throw new UnsafeUrlError("invalid");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError("blocked");
  if (!isIP(host) && (host === "localhost" || host.endsWith(".localhost") || !host.includes("."))) {
    throw new UnsafeUrlError("blocked");
  }
  return url;
}

/** The checked (public) address to pin the socket to. */
export async function checkedSafeAddress(url: URL, deps: Pick<SafeFetchDeps, "resolve">): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("blocked");
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  const addrs = await deps.resolve(host);
  if (!addrs.length) throw new Error("dns_empty");
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new UnsafeUrlError("blocked");
  return addrs[0];
}

/**
 * POSTs `body` to `rawUrl` under the policy above. Throws UnsafeUrlError for a
 * refused URL; every other failure is a result with `ok: false`.
 */
export async function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  deps: SafeFetchDeps = defaultSafeDeps(),
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SafeFetchResult> {
  const url = parseSafeUrl(rawUrl, opts.env);
  const loopback = url.protocol === "http:";
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS);
  try {
    let pinned: ResolvedAddress | null = null;
    if (!loopback) {
      try {
        pinned = await checkedSafeAddress(url, deps);
      } catch (e) {
        if (e instanceof UnsafeUrlError) throw e;
        return { status: 0, ok: false, error: "dns_error" };
      }
    }
    const res = await deps.request({ url, pinned, method: "POST", headers, body, signal: controller.signal });
    if (res.status >= 300 && res.status < 400) return { status: res.status, ok: false, error: "redirect" };
    const ok = res.status >= 200 && res.status < 300;
    return { status: res.status, ok, error: ok ? null : `http_${res.status}` };
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    return { status: 0, ok: false, error: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Node's DNS and http(s); the socket is pinned to the checked address and
 *  the response is read to at most RESPONSE_READ_BYTES, then dropped. */
export function defaultSafeDeps(): SafeFetchDeps {
  return {
    async resolve(host) {
      const all = await dnsLookup(host, { all: true, verbatim: true });
      return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
    },
    request({ url, pinned, method, headers, body, signal }) {
      return new Promise<SafeResponse>((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
          url,
          {
            method,
            signal,
            headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
            ...(pinned ? { lookup: pinnedLookup(pinned) } : {}),
          } as https.RequestOptions,
          (res) => {
            let read = 0;
            res.on("data", (chunk: Buffer) => {
              read += chunk.length;
              if (read > RESPONSE_READ_BYTES) res.destroy();
            });
            res.on("error", () => undefined);
            res.on("close", () => undefined);
            resolve({ status: res.statusCode ?? 0 });
            res.resume();
          },
        );
        req.on("error", reject);
        req.end(body);
      });
    },
  };
}

/** The socket `lookup` that answers with the checked address, whatever the
 *  host resolves to now (pinning; TLS still verifies the host name). */
export function pinnedLookup(pinned: ResolvedAddress) {
  return (_h: string, o: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) =>
    o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family);
}

export { redactedUrl };
