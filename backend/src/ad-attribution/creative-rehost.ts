import { Logger } from "@nestjs/common";

/**
 * SP-15 ruling 6: Meta's signed creative links (fbcdn) stop loading after a
 * few days, so the image is copied once per AdSource into our Media store.
 *
 * Strict fetch rules (Global Constraints → Provider calls):
 *  - `https:` only, and the host must end in `.fbcdn.net`;
 *  - no redirect is followed (a 3xx is a failure);
 *  - 10 s timeout, at most 5 MB, `image/*` only (`MediaService.ingestBuffer`
 *    then sniffs the bytes);
 *  - at most 2 re-hosts at a time per process, off the webhook path;
 *  - a failure is logged as a key (never the signed URL) and retried on the
 *    next referral of the same ad.
 * `META_CDN_TEST_BASE` (Task 4 stubs only) is honoured only when it is
 * exactly `http://127.0.0.1:<port>`; it rewrites `https://<host>/<path>` to
 * `<base>/<host>/<path>` after the rules above passed.
 */

export const CREATIVE_TIMEOUT_MS = 10_000;
export const CREATIVE_MAX_BYTES = 5 * 1024 * 1024;
export const REHOST_CONCURRENCY = 2;

export type CreativeErrorKey =
  | "creative_not_https"
  | "creative_host_refused"
  | "creative_redirect"
  | "creative_http_error"
  | "creative_not_image"
  | "creative_too_large"
  | "creative_timeout"
  | "creative_fetch_failed"
  | "creative_ingest_failed";

export class CreativeFetchError extends Error {
  constructor(readonly key: CreativeErrorKey) {
    super(key);
  }
}

export interface FetchedCreative {
  buffer: Buffer;
  mimeType: string;
}
/** Fetches one already-checked creative URL. Injectable (specs never reach the network). */
export type FetchCreative = (url: string) => Promise<FetchedCreative>;

type Env = Record<string, string | undefined>;

/** The loopback test base, or null when unset or not exactly loopback. */
export function creativeTestBase(env: Env = process.env): string | null {
  const raw = (env.META_CDN_TEST_BASE ?? "").trim();
  const m = /^http:\/\/127\.0\.0\.1:(\d{2,5})$/.exec(raw);
  return m && Number(m[1]) <= 65_535 ? raw : null;
}

/** Checks a creative link and returns the URL to fetch (test base applied). */
export function creativeFetchTarget(link: string, env: Env = process.env): string {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    throw new CreativeFetchError("creative_not_https");
  }
  if (u.protocol !== "https:") throw new CreativeFetchError("creative_not_https");
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".fbcdn.net") || u.username || u.password || (u.port && u.port !== "443")) {
    throw new CreativeFetchError("creative_host_refused");
  }
  const base = creativeTestBase(env);
  return base ? `${base}/${host}${u.pathname}${u.search}` : u.toString();
}

/** The production fetcher: no redirects, timeout, size and type caps. */
export function makeFetchCreative(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): FetchCreative {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? CREATIVE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? CREATIVE_MAX_BYTES;
  return async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { redirect: "manual", signal: ctrl.signal, headers: { accept: "image/*" } });
      } catch {
        throw new CreativeFetchError(ctrl.signal.aborted ? "creative_timeout" : "creative_fetch_failed");
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new CreativeFetchError("creative_redirect");
      }
      if (!res.ok) throw new CreativeFetchError("creative_http_error");
      const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!mimeType.startsWith("image/")) throw new CreativeFetchError("creative_not_image");
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) throw new CreativeFetchError("creative_too_large");
      const buffer = await readCapped(res, maxBytes, ctrl.signal);
      return { buffer, mimeType };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new CreativeFetchError("creative_too_large");
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof CreativeFetchError) throw e;
    throw new CreativeFetchError(signal.aborted ? "creative_timeout" : "creative_fetch_failed");
  }
  return Buffer.concat(chunks);
}

// ─── Per-process limiter and in-flight dedupe ────────────────────────────────

let active = 0;
const waiting: Array<() => void> = [];
const inFlight = new Map<string, Promise<RehostResult>>();

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= REHOST_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Specs: how many re-hosts run right now (never above REHOST_CONCURRENCY). */
export function activeRehosts(): number {
  return active;
}

export type RehostResult = { mediaId: string } | { error: CreativeErrorKey | "creative_missing" };

export interface RehostDeps {
  prisma: {
    adSource: { updateMany(args: unknown): PromiseLike<{ count: number }> };
  };
  media: {
    ingestBuffer(input: { workspaceId: string; buffer: Buffer; mimeType: string; fileName: string }): Promise<{ id: string }>;
  };
  fetchCreative: FetchCreative;
  env?: Env;
  log?: Pick<Logger, "warn">;
}

export interface RehostTarget {
  id: string;
  workspaceId: string;
  sourceId: string;
  mediaId: string | null;
  mediaUrl: string | null;
}

/**
 * Copies one ad's creative into Media and sets `AdSource.mediaId` (only while
 * it is still null). Never throws; returns the media id or the failure key.
 */
export function rehostCreative(adSource: RehostTarget, deps: RehostDeps): Promise<RehostResult> {
  if (adSource.mediaId) return Promise.resolve({ mediaId: adSource.mediaId });
  const running = inFlight.get(adSource.id);
  if (running) return running;
  const p = run(adSource, deps).finally(() => inFlight.delete(adSource.id));
  inFlight.set(adSource.id, p);
  return p;
}

async function run(src: RehostTarget, deps: RehostDeps): Promise<RehostResult> {
  const log = deps.log ?? new Logger("CreativeRehost");
  if (!src.mediaUrl) return { error: "creative_missing" };
  try {
    const target = creativeFetchTarget(src.mediaUrl, deps.env ?? process.env);
    return await limited(async () => {
      const { buffer, mimeType } = await deps.fetchCreative(target);
      let media: { id: string };
      try {
        media = await deps.media.ingestBuffer({
          workspaceId: src.workspaceId,
          buffer,
          mimeType,
          fileName: `ad-${src.sourceId}`,
        });
      } catch {
        throw new CreativeFetchError("creative_ingest_failed");
      }
      await deps.prisma.adSource.updateMany({
        where: { id: src.id, workspaceId: src.workspaceId, mediaId: null },
        data: { mediaId: media.id },
      });
      return { mediaId: media.id };
    });
  } catch (e) {
    const key: CreativeErrorKey = e instanceof CreativeFetchError ? e.key : "creative_fetch_failed";
    // The key and our row id only: the signed URL is never logged.
    log.warn(`creative_rehost_failed key=${key} adSource=${src.id}`);
    return { error: key };
  }
}
