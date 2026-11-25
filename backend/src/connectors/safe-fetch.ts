/**
 * SP-23 SSRF guard for MCP servers the CRM calls as a client (custom
 * connectors always; curated vendors too). Built on `common/public-fetch.ts`'s
 * address policy (`isPublicAddress`, `redactedUrl`), Node core only:
 *
 *  - `https:` only, ports 443 and 8443, no credentials in the URL;
 *  - every address the host resolves to must be public (loopback, RFC 1918,
 *    link-local, CGNAT, multicast, reserved, 0.0.0.0/8, ::1, fc00::/7,
 *    fe80::/10 and IPv4-mapped/NAT64 forms are refused);
 *  - the dial is pinned to the checked address (`lookup` returns it); SNI
 *    and Host stay the original name, so DNS rebinding cannot swap it;
 *  - no redirects (a 3xx is an error);
 *  - 8 s to connect, 30 s in total, a capped response;
 *  - credentials (headers) and the URL query are never logged.
 *
 * `trusted` (a curated URL from code/env) may additionally be a loopback
 * `http://127.0.0.1|localhost` URL outside production (verification stubs);
 * it is still subject to the redirect, timeout and size rules.
 */
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { isPublicAddress, redactedUrl, type ResolvedAddress } from "../common/public-fetch";
import { UPSTREAM_RESPONSE_MAX_BYTES } from "./connector-catalog";

export const CONNECT_TIMEOUT_MS = 8_000;
export const TOTAL_TIMEOUT_MS = 30_000;
const PORTS = new Set(["", "443", "8443"]);

export type SafeFetchCode = "unsafe_url" | "redirect" | "timeout" | "network" | "too_large";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchCode,
    /** A short reason for the UI/log (never a header or a query string). */
    public readonly reason: string,
  ) {
    super(`${code}:${reason}`);
    this.name = "SafeFetchError";
  }
}

export interface SafeRequest {
  url: URL;
  pinned: ResolvedAddress | null;
  method: "POST" | "GET" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  connectTimeoutMs: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Buffer>;
  abort(): void;
}

export interface SafeFetchDeps {
  resolve(host: string): Promise<ResolvedAddress[]>;
  request(req: SafeRequest): Promise<SafeResponse>;
}

export interface SafeFetchResult {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body: string;
  /** The body was cut at maxBytes (only when `truncate` was asked for). */
  truncated: boolean;
}

function isLoopbackDev(url: URL, env: NodeJS.ProcessEnv): boolean {
  return url.protocol === "http:" && env.NODE_ENV !== "production" && /^(127\.0\.0\.1|localhost)$/.test(url.hostname);
}

/** The URL policy alone (create time). Throws SafeFetchError("unsafe_url"). */
export function parseConnectorUrl(raw: string, opts: { trusted?: boolean; env?: NodeJS.ProcessEnv } = {}): URL {
  const env = opts.env ?? process.env;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("unsafe_url", "invalid_url");
  }
  if (opts.trusted && isLoopbackDev(url, env)) return url;
  if (url.protocol !== "https:") throw new SafeFetchError("unsafe_url", "not_https");
  if (url.username || url.password) throw new SafeFetchError("unsafe_url", "credentials_in_url");
  if (!PORTS.has(url.port)) throw new SafeFetchError("unsafe_url", "port_not_allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("unsafe_url", "invalid_url");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError("unsafe_url", "private_address");
  } else if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) {
    throw new SafeFetchError("unsafe_url", "private_address");
  }
  return url;
}

/** Every resolved address must be public; returns the one to pin to. */
export async function checkedAddress(url: URL, deps: Pick<SafeFetchDeps, "resolve">): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError("unsafe_url", "private_address");
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  let addrs: ResolvedAddress[];
  try {
    addrs = await deps.resolve(host);
  } catch {
    throw new SafeFetchError("network", "dns_failed");
  }
  if (!addrs.length) throw new SafeFetchError("network", "dns_failed");
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new SafeFetchError("unsafe_url", "private_address");
  return addrs[0];
}

export interface SafeFetchOptions {
  method?: "POST" | "GET" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  trusted?: boolean;
  maxBytes?: number;
  /** Cut an oversized body at maxBytes instead of failing. */
  truncate?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** One request under the policy. Throws SafeFetchError. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}, deps: SafeFetchDeps = defaultSafeDeps()): Promise<SafeFetchResult> {
  const env = opts.env ?? process.env;
  const url = parseConnectorUrl(rawUrl, { trusted: opts.trusted, env });
  const max = opts.maxBytes ?? UPSTREAM_RESPONSE_MAX_BYTES;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? TOTAL_TIMEOUT_MS);
  try {
    const pinned = opts.trusted && isLoopbackDev(url, env) ? null : await checkedAddress(url, deps);
    let res: SafeResponse;
    try {
      res = await deps.request({
        url,
        pinned,
        method: opts.method ?? "POST",
        headers: opts.headers ?? {},
        body: opts.body,
        signal: controller.signal,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } catch {
      throw new SafeFetchError(timedOut ? "timeout" : "network", timedOut ? "timeout" : "connect_failed");
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
    if (res.status >= 300 && res.status < 400) {
      res.abort();
      throw new SafeFetchError("redirect", `http_${res.status}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    try {
      for await (const chunk of res.body) {
        if (size + chunk.length > max) {
          if (!opts.truncate) {
            res.abort();
            throw new SafeFetchError("too_large", "response_too_large");
          }
          chunks.push(chunk.subarray(0, max - size));
          size = max;
          truncated = true;
          res.abort();
          break;
        }
        chunks.push(chunk);
        size += chunk.length;
      }
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      if (!truncated) throw new SafeFetchError(timedOut ? "timeout" : "network", timedOut ? "timeout" : "read_failed");
    }
    return { status: res.status, headers, body: Buffer.concat(chunks).toString("utf8"), truncated };
  } catch (e) {
    if (e instanceof SafeFetchError) throw e;
    throw new SafeFetchError(timedOut ? "timeout" : "network", timedOut ? "timeout" : "failed");
  } finally {
    clearTimeout(timer);
  }
}

/** The JSON-RPC messages of an SSE body (`data:` lines of each event). */
export function parseSseMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // A non-JSON event (keep-alive, comment) is ignored.
    }
  }
  return out;
}

export function pinnedLookup(pinned: ResolvedAddress) {
  return (_h: string, o: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) =>
    o?.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family);
}

/** Node's DNS and http(s), the socket pinned to the checked address. */
export function defaultSafeDeps(): SafeFetchDeps {
  return {
    async resolve(host) {
      const all = await dnsLookup(host, { all: true, verbatim: true });
      return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
    },
    request({ url, pinned, method, headers, body, signal, connectTimeoutMs }) {
      return new Promise<SafeResponse>((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
          url,
          {
            method,
            signal,
            headers: body !== undefined ? { ...headers, "content-length": String(Buffer.byteLength(body)) } : headers,
            ...(pinned ? { lookup: pinnedLookup(pinned) } : {}),
          } as https.RequestOptions,
          (res) => {
            const out: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(", ") : v;
            resolve({ status: res.statusCode ?? 0, headers: out, body: res, abort: () => res.destroy() });
          },
        );
        const connectTimer = setTimeout(() => req.destroy(new Error("connect_timeout")), connectTimeoutMs);
        req.on("socket", (s) => s.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer)));
        req.on("error", (e) => {
          clearTimeout(connectTimer);
          reject(e);
        });
        req.on("close", () => clearTimeout(connectTimer));
        req.end(body);
      });
    },
  };
}

export { redactedUrl };
