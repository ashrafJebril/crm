/**
 * Spend-relevant amount detection for the confirmation gate. A 500-JOD budget
 * change must not look identical to a 20-JOD one. This surfaces the amounts and
 * raises a VISUAL warn flag above a threshold — it is NOT a block.
 *
 * Meta denominates budgets/bids in the ad account currency's MINOR unit, and the
 * gate cannot know the account currency, so majorEstimate divides by 100 (the
 * common 2-decimal minor unit). For a 3-decimal currency (JOD = 1000 fils) this
 * OVER-estimates → OVER-warns, which is the safe direction for a flag: over-warning
 * is harmless, under-warning is the risk. STEP 5 (which can fetch account currency)
 * does exact formatting; this stays a deliberately conservative heuristic.
 */

const SPEND_FIELDS = ['daily_budget', 'lifetime_budget', 'bid_amount', 'budget', 'bid_cap'];
const MAX_DEPTH = 6;

export interface SpendItem {
  field: string;
  minorValue: number; // the raw value as Meta receives it
  majorEstimate: number; // minorValue / 100 — conservative, over-estimates for 3-decimal currencies
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Recursively collect spend-relevant amounts anywhere in the args (nested budgets
 *  in bulk/schedule ops included). Over-inclusive by design — a false hit only
 *  over-warns. */
export function extractSpend(value: unknown, depth = 0): SpendItem[] {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return [];
  const out: SpendItem[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SPEND_FIELDS.includes(k)) {
      const n = toNumber(v);
      if (n != null && n > 0) out.push({ field: k, minorValue: n, majorEstimate: Math.round(n) / 100 });
    } else if (v && typeof v === 'object') {
      out.push(...extractSpend(v, depth + 1));
    }
  }
  return out;
}

export function approvalWarnJod(): number {
  const v = Number(process.env.ADS_APPROVAL_AMOUNT_WARN ?? '50');
  return Number.isFinite(v) && v > 0 ? v : 50;
}

export function spendWarns(spend: SpendItem[], warnJod: number): boolean {
  return spend.some((s) => s.majorEstimate >= warnJod);
}
