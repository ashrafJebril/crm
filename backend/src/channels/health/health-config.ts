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
