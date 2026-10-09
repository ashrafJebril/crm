import { Prisma } from '@prisma/client';

/**
 * hjz-ads — pure, testable pricing. Turns real Claude token usage into a JOD
 * charge. All money math uses Prisma.Decimal (decimal.js) — NEVER float. Config
 * is read from env AT CALL TIME (not module load) so a redeploy/env flip takes
 * effect without a restart, and tests can set env per-case.
 *
 * Prices, margin and FX are BACKEND-ONLY — the tenant never sees them; the
 * frozen breakdown on each DEBIT row is what keeps a past charge provable after
 * these values change.
 */

// Smallest representable unit at Decimal(12,4). A call that consumed tokens is
// never free: if the computed charge rounds below this, it's floored to it.
export const MIN_CHARGE_JOD = new Prisma.Decimal('0.0001');

const ONE_MILLION = new Prisma.Decimal(1_000_000);

// Prompt-cache multipliers on the BASE input price (Anthropic 5-min ephemeral
// cache): a cache WRITE bills at 1.25x input, a cache READ at 0.10x input.
// Frozen into each DEBIT's breakdown so a past charge stays provable if these
// change. Re-verify against Anthropic pricing when they do.
const CACHE_WRITE_MULT = new Prisma.Decimal('1.25');
const CACHE_READ_MULT = new Prisma.Decimal('0.10');

export interface AdsPricingConfig {
  inputPricePer1M: Prisma.Decimal;  // USD / 1M input tokens
  outputPricePer1M: Prisma.Decimal; // USD / 1M output tokens
  marginMultiplier: Prisma.Decimal; // 2.0 = 100% profit
  usdToJod: Prisma.Decimal;         // safety-padded FX
}

// Parse an env var as Decimal, falling back to `def`. Invalid non-empty values
// throw (fail loud on misconfig rather than silently mispricing).
function envDecimal(name: string, def: string): Prisma.Decimal {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return new Prisma.Decimal(def);
  return new Prisma.Decimal(raw.trim()); // throws on garbage
}

// Per-model USD rates (per 1M tokens). A Haiku reply from the cheap gate MUST
// bill at Haiku's rate, never Sonnet's — so the input/output price is selected by
// the model ACTUALLY used, not one flat env pair. Margin and FX are
// model-independent. Matched by family PREFIX so a dated id
// (claude-haiku-4-5-20251001) resolves too. Anything that isn't Haiku keeps the
// existing ADS_PRICE_* pair, so Sonnet billing is byte-for-byte unchanged. Add a
// branch when another model goes live; defaults are the public list prices.
function modelRates(model: string): { input: Prisma.Decimal; output: Prisma.Decimal } {
  if (model.startsWith('claude-haiku')) {
    return {
      input: envDecimal('ADS_PRICE_INPUT_PER_1M_HAIKU', '1.00'),
      output: envDecimal('ADS_PRICE_OUTPUT_PER_1M_HAIKU', '5.00'),
    };
  }
  return {
    input: envDecimal('ADS_PRICE_INPUT_PER_1M', '3.00'),
    output: envDecimal('ADS_PRICE_OUTPUT_PER_1M', '15.00'),
  };
}

// `model` selects the per-model rate pair; margin + FX are shared across models.
export function loadPricingConfig(model: string): AdsPricingConfig {
  const rates = modelRates(model);
  return {
    inputPricePer1M: rates.input,
    outputPricePer1M: rates.output,
    marginMultiplier: envDecimal('ADS_MARGIN_MULTIPLIER', '2.0'),
    usdToJod: envDecimal('ADS_USD_TO_JOD', '0.72'),
  };
}

/**
 * Authorization threshold for hasBalance(): refuse a NEW request BEFORE spending
 * tokens unless the wallet can plausibly fund one call. THIS is where the loss
 * is preventable — `balance > 0` is not enough, because a 0.0001 balance passes
 * it, Claude spends ~0.035+, and the call drains-to-zero subsidised. Read at
 * call time; fails loud on garbage (same envDecimal as pricing). A complex
 * request can reach ~0.5 JOD, hence the default.
 */
export function loadMinBalanceJod(): Prisma.Decimal {
  return envDecimal('ADS_MIN_BALANCE_JOD', '0.5000');
}

export interface ChargeBreakdown {
  inputTokens: number;
  outputTokens: number;
  // Cache tokens, now PRICED (caching is enabled): cache reads bill at 0.10x
  // input, cache writes at 1.25x — folded into usdCost in computeChargeJod.
  // Recorded here, with the multipliers below, so a past charge stays provable.
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usdCost: string;          // Decimal serialized
  multiplier: string;
  fxRate: string;
  model: string;
  inputPricePer1M: string;
  outputPricePer1M: string;
  cacheWriteMult: string;   // input-price multiplier for cache-creation tokens
  cacheReadMult: string;    // input-price multiplier for cache-read tokens
}

export interface ChargeResult {
  jod: Prisma.Decimal;
  breakdown: ChargeBreakdown;
}

/**
 * usdCost = input/1e6 * inputPrice + output/1e6 * outputPrice
 * jod     = usdCost * marginMultiplier * usdToJod, rounded to 4dp (HALF_UP,
 *           decimal.js default), floored to MIN_CHARGE_JOD when tokens > 0.
 */
export function computeChargeJod(args: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  model: string;
}): ChargeResult {
  const cfg = loadPricingConfig(args.model);

  // Guard against NaN / negative / fractional token counts.
  const inTok = new Prisma.Decimal(Math.max(0, Math.trunc(args.inputTokens || 0)));
  const outTok = new Prisma.Decimal(Math.max(0, Math.trunc(args.outputTokens || 0)));
  const cacheWriteTok = new Prisma.Decimal(Math.max(0, Math.trunc(args.cacheCreationInputTokens || 0)));
  const cacheReadTok = new Prisma.Decimal(Math.max(0, Math.trunc(args.cacheReadInputTokens || 0)));

  // Cache tokens are billed SEPARATELY from input_tokens: once cache_control is
  // set, the cached prefix (tools+system, ~2.1-2.7k tok) leaves input_tokens and
  // lands in cache_read/creation. Price them at 0.10x / 1.25x of input here, or
  // every cached call undercharges. When caching is off both are 0 → no effect.
  const usdCost = inTok.dividedBy(ONE_MILLION).times(cfg.inputPricePer1M)
    .plus(outTok.dividedBy(ONE_MILLION).times(cfg.outputPricePer1M))
    .plus(cacheWriteTok.dividedBy(ONE_MILLION).times(cfg.inputPricePer1M).times(CACHE_WRITE_MULT))
    .plus(cacheReadTok.dividedBy(ONE_MILLION).times(cfg.inputPricePer1M).times(CACHE_READ_MULT));

  let jod = usdCost.times(cfg.marginMultiplier).times(cfg.usdToJod)
    .toDecimalPlaces(4); // decimal.js default rounding = ROUND_HALF_UP

  if (inTok.plus(outTok).greaterThan(0) && jod.lessThan(MIN_CHARGE_JOD)) {
    jod = MIN_CHARGE_JOD; // never a free call
  }

  // Cache tokens ARE priced in usdCost above (0.10x input for reads, 1.25x for
  // writes — Anthropic's 5-min ephemeral cache). Billed separately from
  // input_tokens, so pricing them here is what stops a cached call from
  // undercharging. Multipliers are frozen into the breakdown below so a past
  // charge stays reprovable if they change; re-verify on any change.
  return {
    jod,
    breakdown: {
      inputTokens: inTok.toNumber(),
      outputTokens: outTok.toNumber(),
      cacheReadInputTokens: cacheReadTok.toNumber(),
      cacheCreationInputTokens: cacheWriteTok.toNumber(),
      usdCost: usdCost.toString(),
      multiplier: cfg.marginMultiplier.toString(),
      fxRate: cfg.usdToJod.toString(),
      model: args.model,
      inputPricePer1M: cfg.inputPricePer1M.toString(),
      outputPricePer1M: cfg.outputPricePer1M.toString(),
      cacheWriteMult: CACHE_WRITE_MULT.toString(),
      cacheReadMult: CACHE_READ_MULT.toString(),
    },
  };
}
