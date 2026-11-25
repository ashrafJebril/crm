/**
 * SP-16 counts and pages that never block (ruling 10): every audience query
 * runs in an interactive transaction that first sets a per-statement
 * timeout. A statement timeout answers `timedOut: true` (count `null`); a
 * pool or transaction timeout answers `busy` / `skipped` (final review M4:
 * "not counted yet", never cached). Never a 500.
 */
import type { Prisma } from "@prisma/client";

export const DEFAULT_COUNT_TIMEOUT_MS = 8000;
export const DEFAULT_COUNT_TTL_MS = 5 * 60_000;
/** Fix I1: `GET /segments` spends at most this long on counts overall. */
export const DEFAULT_LIST_DEADLINE_MS = 10_000;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 100 && n <= 600_000 ? Math.floor(n) : fallback;
}

export const countTimeoutMs = () => envMs("AUDIENCE_COUNT_TIMEOUT_MS", DEFAULT_COUNT_TIMEOUT_MS);
export const countTtlMs = () => envMs("AUDIENCE_COUNT_TTL_MS", DEFAULT_COUNT_TTL_MS);
export const listDeadlineMs = () => envMs("AUDIENCE_LIST_DEADLINE_MS", DEFAULT_LIST_DEADLINE_MS);

/** The transaction-client surface the timed queries use. */
export interface TimedTx {
  $executeRawUnsafe(sql: string): Promise<unknown>;
  contact: {
    count(args: { where: Prisma.ContactWhereInput }): Promise<number>;
    findMany(args: unknown): Promise<unknown[]>;
  };
}

export interface TimedPrisma {
  $transaction<T>(fn: (tx: TimedTx) => Promise<T>, opts?: { timeout?: number; maxWait?: number }): Promise<T>;
}

/**
 * What kind of timeout an error is (SP-16 final review M4):
 * - "statement": Postgres 57014 (query_canceled by `statement_timeout`), as
 *   Prisma surfaces it: on the error, its `meta`, its message, or a wrapped
 *   `cause`. The audience really is too large to count right now; cached.
 * - "transaction": Prisma P2028 (interactive transaction expired, or the
 *   `maxWait` pool wait ran out) or P2024 (no pooled connection). That is load,
 *   not size: answered as "not counted yet" and never cached.
 */
export function timeoutKind(e: unknown, depth = 0): "statement" | "transaction" | null {
  const err = e as { code?: unknown; meta?: Record<string, unknown>; message?: unknown; cause?: unknown } | null;
  if (!err || typeof err !== "object" || depth > 3) return null;
  if (err.code === "57014" || err.meta?.code === "57014") return "statement";
  if (err.code === "P2028" || err.code === "P2024") return "transaction";
  const texts = [err.message, err.meta?.message, err.meta?.database_error].filter((x): x is string => typeof x === "string");
  if (texts.some((t) => /\b57014\b|canceling statement due to statement timeout/i.test(t))) return "statement";
  return err.cause ? timeoutKind(err.cause, depth + 1) : null;
}

/** A real statement timeout (Postgres 57014) only. */
export function isStatementTimeout(e: unknown): boolean {
  return timeoutKind(e) === "statement";
}

export type TimedResult<T> =
  | { value: T; timedOut: false; busy: false }
  | { value: null; timedOut: true; busy: false }
  | { value: null; timedOut: false; busy: true };

/**
 * Run `fn` in one transaction after `SET LOCAL statement_timeout = <ms>`.
 * A statement timeout gives `{timedOut: true}`; a transaction or pool
 * timeout gives `{busy: true}`; any other error is rethrown.
 */
export async function withStatementTimeout<T>(
  prisma: TimedPrisma,
  ms: number,
  fn: (tx: TimedTx) => Promise<T>,
): Promise<TimedResult<T>> {
  const limit = Math.max(1, Math.floor(ms));
  try {
    const value = await prisma.$transaction(
      async (tx) => {
        // SET cannot take a bind parameter; `limit` is an integer we computed.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${limit}`);
        return fn(tx);
      },
      { timeout: limit + 5000, maxWait: 5000 },
    );
    return { value, timedOut: false, busy: false };
  } catch (e) {
    const kind = timeoutKind(e);
    if (kind === "statement") return { value: null, timedOut: true, busy: false };
    if (kind === "transaction") return { value: null, timedOut: false, busy: true };
    throw e;
  }
}

/** `skipped`: not counted in this request (pool or transaction timeout); never cached. */
export async function countWithTimeout(
  prisma: TimedPrisma,
  where: Prisma.ContactWhereInput,
  ms: number = countTimeoutMs(),
): Promise<{ count: number | null; timedOut: boolean; skipped: boolean }> {
  const r = await withStatementTimeout(prisma, ms, (tx) => tx.contact.count({ where }));
  if (r.timedOut) return { count: null, timedOut: true, skipped: false };
  if (r.busy) return { count: null, timedOut: false, skipped: true };
  return { count: r.value, timedOut: false, skipped: false };
}

/**
 * Cache a smart audience's count. Raw SQL on purpose: a Prisma update would
 * move `updatedAt`, which the UI shows as "edited". `count: null` caches a
 * timed-out count (fix I1): a recent `countedAt` with a null `memberCount`
 * means "too large to count right now", and the TTL suppresses retries.
 */
export async function writeCountCache(
  prisma: { $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown> },
  ws: string,
  id: string,
  count: number | null,
  at: Date,
): Promise<void> {
  await prisma.$executeRaw`UPDATE "Segment" SET "memberCount" = ${count}, "countedAt" = ${at} WHERE "id" = ${id} AND "workspaceId" = ${ws}`;
}

/** `p-limit`-style: map with at most `limit` promises in flight (no dependency). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
