/**
 * SP-16 counts and pages that never block (ruling 10): every audience query
 * runs in an interactive transaction that first sets a per-statement
 * timeout. A timeout answers `timedOut: true` (count `null`), never a 500.
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

/** Postgres 57014 (query_canceled by statement_timeout), as Prisma surfaces it, or an expired interactive transaction. */
export function isStatementTimeout(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  if (!err) return false;
  if (err.code === "57014" || err.meta?.code === "57014" || err.code === "P2028") return true;
  const msg = typeof err.message === "string" ? err.message : "";
  return /57014|statement timeout|canceling statement due to/i.test(msg);
}

/**
 * Run `fn` in one transaction after `SET LOCAL statement_timeout = <ms>`.
 * A timeout gives `{timedOut: true}`; any other error is rethrown.
 */
export async function withStatementTimeout<T>(
  prisma: TimedPrisma,
  ms: number,
  fn: (tx: TimedTx) => Promise<T>,
): Promise<{ value: T; timedOut: false } | { value: null; timedOut: true }> {
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
    return { value, timedOut: false };
  } catch (e) {
    if (isStatementTimeout(e)) return { value: null, timedOut: true };
    throw e;
  }
}

export async function countWithTimeout(
  prisma: TimedPrisma,
  where: Prisma.ContactWhereInput,
  ms: number = countTimeoutMs(),
): Promise<{ count: number | null; timedOut: boolean }> {
  const r = await withStatementTimeout(prisma, ms, (tx) => tx.contact.count({ where }));
  return r.timedOut ? { count: null, timedOut: true } : { count: r.value, timedOut: false };
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
