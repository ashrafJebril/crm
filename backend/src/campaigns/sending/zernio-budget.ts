import { ZernioRateLimitError } from "../../integrations/zernio.client";

/**
 * SP-13 ruling R19: one Zernio API key serves every workspace (team limit
 * 600 requests per minute), so campaign launch calls share a process-wide
 * budget: `ZERNIO_CAMPAIGN_RPM` (default 300, half the team limit, leaving
 * headroom for inbox replies and syncs). Direct sends also pass a stricter
 * `CAMPAIGN_DIRECT_RPM` bucket (default 120) inside it. Per machine, like
 * SP-19's rate limits (`min_machines_running = 1`).
 */

type Env = Record<string, string | undefined>;

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const ZERNIO_CAMPAIGN_RPM = 300;
export const CAMPAIGN_DIRECT_RPM = 120;
export const zernioCampaignRpm = (env: Env = process.env) => positiveInt(env.ZERNIO_CAMPAIGN_RPM, ZERNIO_CAMPAIGN_RPM);
export const campaignDirectRpm = (env: Env = process.env) => positiveInt(env.CAMPAIGN_DIRECT_RPM, CAMPAIGN_DIRECT_RPM);

/** Time source; tests pass a virtual one whose sleep advances it. */
export interface BudgetClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: BudgetClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * A token bucket (GCRA): at most `rpm` calls per minute after a burst of
 * `burst` calls. A slot is reserved synchronously, so concurrent callers
 * queue fairly instead of racing.
 */
export class TokenBucket {
  private readonly interval: number;
  private readonly tolerance: number;
  private tat = 0;

  constructor(
    readonly rpm: number,
    private readonly clock: BudgetClock = realClock,
    burst = Math.max(1, Math.floor(rpm / 60)),
  ) {
    this.interval = 60_000 / rpm;
    this.tolerance = (Math.max(1, burst) - 1) * this.interval;
  }

  /**
   * Fix round 1 (m3): a 429 is team-wide, so its Retry-After holds every
   * caller of this bucket, not only the one that got it.
   */
  pause(ms: number): void {
    if (!(ms > 0)) return;
    this.tat = Math.max(this.tat, this.clock.now() + ms + this.tolerance);
  }

  async take(): Promise<void> {
    const now = this.clock.now();
    const tat = Math.max(this.tat, now);
    const wait = tat - this.tolerance - now;
    this.tat = tat + this.interval;
    if (wait > 0) await this.clock.sleep(wait);
  }
}

/** The campaign bucket and the direct-send bucket (taken in that order). */
export class ZernioBudget {
  readonly campaign: TokenBucket;
  readonly direct: TokenBucket;

  constructor(env: Env = process.env, clock: BudgetClock = realClock) {
    this.campaign = new TokenBucket(zernioCampaignRpm(env), clock);
    this.direct = new TokenBucket(campaignDirectRpm(env), clock);
  }

  private static instance: ZernioBudget | null = null;
  /** The process-wide budget (env read once, on first use). */
  static shared(): ZernioBudget {
    return (ZernioBudget.instance ??= new ZernioBudget());
  }
}

/** Default wait when a 429 carries no Retry-After. */
export const RETRY_AFTER_DEFAULT_MS = 5_000;
/** Longest single wait, so the launch lease (stale after 2 min) stays fresh. */
export const RETRY_AFTER_MAX_MS = 60_000;

/**
 * Runs `fn`; on a Zernio 429 waits its Retry-After (default 5 s, at most
 * `maxWaitMs`) and tries again, up to `maxRetries` times, then rethrows the
 * 429 (a transient launch error). `before` runs before every attempt: the
 * runner takes its budget tokens and fences its lease there, so a retried
 * call is still a fenced call. Any other error passes through.
 */
export async function withRetryAfter<T>(
  fn: () => Promise<T>,
  opts: {
    sleep: (ms: number) => Promise<void>;
    before?: () => Promise<void>;
    /** Called with the wait before sleeping it (the runner pauses the shared bucket). */
    onRateLimit?: (waitMs: number) => void;
    maxRetries?: number;
    maxWaitMs?: number;
  },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxWait = opts.maxWaitMs ?? RETRY_AFTER_MAX_MS;
  for (let attempt = 0; ; attempt++) {
    if (opts.before) await opts.before();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ZernioRateLimitError) || attempt >= maxRetries) throw e;
      const wait = Math.min(e.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, maxWait);
      opts.onRateLimit?.(wait);
      await opts.sleep(wait);
    }
  }
}

/** The part of a bucket a budgeted caller needs (specs pass a stub). */
export type BudgetBucket = Pick<TokenBucket, "take" | "pause">;

/**
 * SP-13 final review (R19): one budgeted Zernio call outside the launch
 * runner (template checks, recipient sweeps, stats syncs, cancel/delete
 * reads). Takes a token first; a 429 pauses the whole bucket for its
 * Retry-After (default RETRY_AFTER_DEFAULT_MS, at most RETRY_AFTER_MAX_MS),
 * so every other campaign caller waits too, then rethrows (no retry here:
 * these callers already retry on their next tick or click).
 */
export async function budgeted<T>(bucket: BudgetBucket, fn: () => Promise<T>): Promise<T> {
  await bucket.take();
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ZernioRateLimitError) bucket.pause(Math.min(e.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS, RETRY_AFTER_MAX_MS));
    throw e;
  }
}
