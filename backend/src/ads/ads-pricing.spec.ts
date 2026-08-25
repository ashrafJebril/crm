import { Prisma } from '@prisma/client';
import { computeChargeJod, MIN_CHARGE_JOD } from './ads-pricing';

const ENV_KEYS = [
  'ADS_PRICE_INPUT_PER_1M',
  'ADS_PRICE_OUTPUT_PER_1M',
  'ADS_PRICE_INPUT_PER_1M_HAIKU',
  'ADS_PRICE_OUTPUT_PER_1M_HAIKU',
  'ADS_MARGIN_MULTIPLIER',
  'ADS_USD_TO_JOD',
];

describe('computeChargeJod', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it('charges the expected JOD for a known usage with default env', () => {
    // Defaults (env unset): input $3.00/1M, output $15.00/1M, margin 2.0x, FX 0.72.
    // 100,000 input + 50,000 output tokens, no cache tokens:
    //   usdCost = (100000/1e6)*3.00 + (50000/1e6)*15.00 = 0.30 + 0.75 = 1.05
    //   jod     = 1.05 * 2.0 * 0.72 = 1.512
    const expectedUsd = new Prisma.Decimal(100_000)
      .dividedBy(1_000_000)
      .times('3.00')
      .plus(new Prisma.Decimal(50_000).dividedBy(1_000_000).times('15.00'));
    const expectedJod = expectedUsd.times('2.0').times('0.72').toDecimalPlaces(4);

    const result = computeChargeJod({
      inputTokens: 100_000,
      outputTokens: 50_000,
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(result.breakdown.usdCost).toBe(expectedUsd.toString());
    expect(result.jod.toString()).toBe(expectedJod.toString());
    expect(result.jod.toString()).toBe('1.512');
  });

  it('floors to MIN_CHARGE_JOD when tokens > 0 but the computed charge rounds below it', () => {
    // 1 input token: usdCost = (1/1e6)*3.00 = 0.000003; jod = 0.000003*2*0.72 = 0.00000432
    // which rounds to 0.0000 at 4dp — floored up to MIN_CHARGE_JOD (0.0001) since tokens > 0.
    const result = computeChargeJod({
      inputTokens: 1,
      outputTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(result.jod.equals(MIN_CHARGE_JOD)).toBe(true);
    expect(result.jod.toString()).toBe('0.0001');
  });

  it('never floors a zero-token call (no tokens consumed => no charge)', () => {
    const result = computeChargeJod({
      inputTokens: 0,
      outputTokens: 0,
      model: 'claude-sonnet-4-5-20250929',
    });

    expect(result.jod.toString()).toBe('0');
  });

  it('routes a haiku-prefixed model to the (cheaper) haiku rates, not the default pair', () => {
    // Haiku defaults: input $1.00/1M, output $5.00/1M.
    //   usdCost = (100000/1e6)*1.00 + (50000/1e6)*5.00 = 0.10 + 0.25 = 0.35
    //   jod     = 0.35 * 2.0 * 0.72 = 0.504
    const result = computeChargeJod({
      inputTokens: 100_000,
      outputTokens: 50_000,
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.breakdown.inputPricePer1M).toBe(new Prisma.Decimal('1.00').toString());
    expect(result.breakdown.outputPricePer1M).toBe(new Prisma.Decimal('5.00').toString());
    expect(result.jod.toString()).toBe('0.504');
  });
});
