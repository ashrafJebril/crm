/** SP-14 health knobs (ruling 5). */
type Env = Record<string, string | undefined>;

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/** One live check per number per this many ms (DB-backed, `healthAttemptedAt`). */
export const HEALTH_CHECK_COOLDOWN_MS = 60_000;
/** Live checks per workspace per minute (in memory, per machine). */
export const HEALTH_CHECK_WS_PER_MIN = 10;

export const healthCooldownMs = (env: Env = process.env) => positiveInt(env.HEALTH_CHECK_COOLDOWN_MS, HEALTH_CHECK_COOLDOWN_MS);
export const healthWsPerMin = (env: Env = process.env) => positiveInt(env.HEALTH_CHECK_WS_PER_MIN, HEALTH_CHECK_WS_PER_MIN);

/** SP-14 sweep (ruling 7): numbers checked per hourly tick. */
export const HEALTH_SWEEP_BATCH = 50;
/** A number is due once its last attempt is this old (about one check a day). */
export const HEALTH_SWEEP_INTERVAL_MS = 24 * 3_600_000;
/** A tick starts no new check after this long. */
export const HEALTH_SWEEP_MAX_MS = 10 * 60_000;

export const healthSweepBatch = (env: Env = process.env) => positiveInt(env.HEALTH_SWEEP_BATCH, HEALTH_SWEEP_BATCH);
export const healthSweepIntervalMs = (env: Env = process.env) => positiveInt(env.HEALTH_SWEEP_INTERVAL_MS, HEALTH_SWEEP_INTERVAL_MS);
export const healthSweepMaxMs = (env: Env = process.env) => positiveInt(env.HEALTH_SWEEP_MAX_MS, HEALTH_SWEEP_MAX_MS);

/** Review m1: webhook-triggered checks per workspace per minute (separate from the live-check cap). */
export const HEALTH_WEBHOOK_WS_PER_MIN = 30;
export const healthWebhookWsPerMin = (env: Env = process.env) => positiveInt(env.HEALTH_WEBHOOK_WS_PER_MIN, HEALTH_WEBHOOK_WS_PER_MIN);
