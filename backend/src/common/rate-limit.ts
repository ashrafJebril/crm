/**
 * A small in-memory sliding-window rate limiter (SP-19 widget endpoints).
 *
 * Per process: with N machines the effective limit is N times higher (the
 * plan accepts this while fly.toml runs one machine). Pure: the clock is
 * injectable, so specs drive it without timers.
 *
 * Memory is bounded: a key's timestamps are capped at `limit`, keys whose
 * newest hit left the window are pruned on a sweep, and when `maxKeys` is
 * reached the oldest-inserted keys are evicted (a flood of fresh keys can
 * only reset other keys' counters, never grow the map without bound).
 */
export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}

export interface LimitResult {
  ok: boolean;
  /** Seconds until the next hit would be allowed (0 when ok). */
  retryAfterSec: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(opts: SlidingWindowOptions) {
    if (!(opts.limit >= 1) || !(opts.windowMs >= 1)) throw new Error("SlidingWindowLimiter: limit and windowMs must be positive");
    this.limit = Math.floor(opts.limit);
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = Math.max(1, opts.maxKeys ?? 50_000);
  }

  /** Record one hit for `key` if it is under the limit. A refused hit is not recorded. */
  hit(key: string): LimitResult {
    const now = this.now();
    this.sweep(now);
    const since = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const retryAfterMs = list[0] + this.windowMs - now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    list.push(now);
    if (!this.hits.has(key)) this.evictFor(1);
    this.hits.set(key, list);
    return { ok: true, retryAfterSec: 0 };
  }

  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const since = now - this.windowMs;
    for (const [k, list] of this.hits) {
      if (!list.length || list[list.length - 1] <= since) this.hits.delete(k);
    }
  }

  private evictFor(n: number): void {
    while (this.hits.size + n > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) return;
      this.hits.delete(oldest.value);
    }
  }
}
