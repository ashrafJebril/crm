import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getWorkspaceContext } from '../common/workspace-context';
import type { GetAdsWalletResponse, AdsWalletTransactionDto } from './ads.types';
import { computeChargeJod, loadMinBalanceJod } from './ads-pricing';

const ZERO = new Prisma.Decimal(0);
const RECENT_TX_LIMIT = 20;

// Canonical 4-dp wire string for a Decimal(12,4) money value (see contracts).
const decStr = (d: Prisma.Decimal): string => d.toFixed(4);

// Credit types only — DEBIT is produced solely by debit(), never passed in.
export type AdsWalletCreditType = 'MONTHLY_GRANT' | 'TOPUP' | 'REFUND' | 'ADJUST';

/**
 * Pre-check refusal: the wallet cannot fund further spend. Raised at the
 * authorization boundary BEFORE Claude runs (so no tokens are spent), same
 * shape as AdsChatLimitError. debit() itself does NOT throw this on overdraw —
 * once tokens are spent it records the charge (drain-to-zero) instead.
 */
export class InsufficientBalanceError extends Error {
  constructor(readonly balanceJod: Prisma.Decimal, readonly requiredJod?: Prisma.Decimal) {
    super(
      `Ads wallet balance ${balanceJod.toFixed(4)} JOD is insufficient` +
        (requiredJod ? ` for a charge of ${requiredJod.toFixed(4)} JOD` : ''),
    );
    this.name = 'InsufficientBalanceError';
  }
}

@Injectable()
export class AdsWalletService {
  private readonly logger = new Logger(AdsWalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  private workspaceId(): string {
    const ctx = getWorkspaceContext();
    if (!ctx) throw new Error('AdsWalletService: no workspace context (wrap in workspaceContext.run)');
    return ctx.workspaceId;
  }

  /** Workspace-scoped; creates a zero-balance wallet on first access. Upsert is
   *  atomic against the workspaceId unique constraint (no create-race). */
  async getOrCreateWallet() {
    return this.prisma.adsWallet.upsert({
      where: { workspaceId: this.workspaceId() },
      create: { balanceJod: ZERO } as any, // workspaceId injected by workspace-scope ext
      update: {},
    });
  }

  /** { wallet, recentTransactions } per the contracts DTO (Decimals → strings). */
  async getWallet(): Promise<GetAdsWalletResponse> {
    const wallet = await this.getOrCreateWallet();
    const rows = await this.prisma.adsWalletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: RECENT_TX_LIMIT,
    });
    return {
      wallet: { balanceJod: decStr(wallet.balanceJod), updatedAt: wallet.updatedAt.toISOString() },
      recentTransactions: rows.map((r) => this.toDto(r)),
    };
  }

  /**
   * Pre-spend authorization gate — the ONLY place the overdraw loss is
   * preventable. Returns true only if the balance can plausibly fund a call:
   * balance >= threshold, where threshold defaults to env ADS_MIN_BALANCE_JOD
   * (0.5000 JOD) and can be overridden per-call (e.g. an estimated ceiling from
   * max_tokens). The chat layer calls this BEFORE Claude runs and refuses with
   * InsufficientBalanceError when false. Does NOT create the wallet (cheap).
   */
  async hasBalance(minRequiredJod?: Prisma.Decimal | string | number): Promise<boolean> {
    const threshold =
      minRequiredJod !== undefined ? new Prisma.Decimal(minRequiredJod) : loadMinBalanceJod();
    const w = await this.prisma.adsWallet.findUnique({
      where: { workspaceId: this.workspaceId() },
      select: { balanceJod: true },
    });
    const balance = w?.balanceJod ?? ZERO;
    return balance.gte(threshold);
  }

  /** Current balance (0 if no wallet yet). Pure read — does NOT create the
   *  wallet (unlike getOrCreateWallet). Used for the pre-spend gate's error and
   *  the post-debit response balance. */
  async getBalance(): Promise<Prisma.Decimal> {
    const w = await this.prisma.adsWallet.findUnique({
      where: { workspaceId: this.workspaceId() },
      select: { balanceJod: true },
    });
    return w?.balanceJod ?? ZERO;
  }

  /**
   * Meter one Claude reply. Called AFTER the tokens were spent. Atomic:
   *  - full-charge path: decrement ONLY if balance covers it (guard in WHERE) —
   *    concurrent debits serialise on the row lock, can't double-spend.
   *  - overdraw path (0 <= balance < charge): drain to zero, record the real
   *    charge in breakdownJson (policy (a)). amountJod == JOD actually removed,
   *    so SUM(amountJod) still equals balanceAfterJod (0). The DB CHECK is the
   *    final backstop.
   */
  async debit(args: {
    inputTokens: number;
    outputTokens: number;
    // PRICED (not just recorded): computeChargeJod (ads-pricing.ts:132-135) bills
    // cache reads at 0.10x input and writes at 1.25x. Measured on the stored row
    // 553b62ad (2026-07-17): usdCost 0.1597116 vs 0.155694 for in+out alone —
    // delta 0.0040176 = 13392 cacheRead × $3/1M × 0.10. cache_control is live.
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    model: string;
    description?: string | null;
  }): Promise<{ charged: Prisma.Decimal; balanceAfter: Prisma.Decimal; shortfallJod: Prisma.Decimal }> {
    const { jod: charge, breakdown } = computeChargeJod(args);
    const workspaceId = this.workspaceId();

    // Derived indexed mirror of the blob, written in the SAME transaction below.
    // costBasisUsd = list-priced cost (NOT real cost); costBasisJod = it × the
    // row's FROZEN fxRate, so margin = SUM(amountJod)/SUM(costBasisJod) needs no
    // JSON. On the overdraw path these hold the FULL cost incurred while amountJod
    // holds only what was collected — that's what makes the subsidy legible.
    const costBasisUsd = new Prisma.Decimal(breakdown.usdCost);
    const costBasisJod = costBasisUsd.times(breakdown.fxRate);

    return this.prisma.$transaction(async (tx: any) => {
      await tx.adsWallet.upsert({
        where: { workspaceId },
        create: { balanceJod: ZERO } as any, // workspaceId injected by workspace-scope ext
        update: {},
      });

      const applied = await tx.adsWallet.updateMany({
        where: { workspaceId, balanceJod: { gte: charge as any } },
        data: { balanceJod: { decrement: charge as any } },
      });

      if (applied.count === 1) {
        const w = await tx.adsWallet.findFirstOrThrow({ where: { workspaceId }, select: { id: true, balanceJod: true } });
        await tx.adsWalletTransaction.create({
          data: {
            walletId: w.id,
            type: 'DEBIT',
            amountJod: charge.negated() as any,
            balanceAfterJod: w.balanceJod as any,
            description: args.description ?? null,
            breakdownJson: breakdown as any,
            costBasisUsd: costBasisUsd as any,
            costBasisJod: costBasisJod as any,
          },
        });
        return { charged: charge, balanceAfter: w.balanceJod, shortfallJod: ZERO };
      }

      // Overdraw fallback — recover everything, drain to zero, prove the subsidy.
      const before = await tx.adsWallet.findFirstOrThrow({ where: { workspaceId }, select: { id: true, balanceJod: true } });
      const collected = before.balanceJod;        // 0 <= collected < charge
      const shortfall = charge.minus(collected);
      await tx.adsWallet.updateMany({ where: { workspaceId }, data: { balanceJod: ZERO as any } });
      await tx.adsWalletTransaction.create({
        data: {
          walletId: before.id,
          type: 'DEBIT',
          amountJod: collected.negated() as any, // ledger integrity: what actually left
          balanceAfterJod: ZERO as any,
          description: args.description ?? null,
          breakdownJson: {
            ...breakdown,
            chargedJod: charge.toFixed(4),
            collectedJod: collected.toFixed(4),
            shortfallJod: shortfall.toFixed(4),
            overdraw: true,
          } as any,
          // Full cost incurred (we made the API call), even though only `collected`
          // was recovered — so costBasisJod > |amountJod| renders the subsidy.
          costBasisUsd: costBasisUsd as any,
          costBasisJod: costBasisJod as any,
        },
      });
      // TRIPWIRE: overdraw was 0/45 rows as of 2026-07-17, so the "margin uses
      // collected" rule is currently free (amountJod == billed on every row). This
      // fires the first time that stops being true — the latent design decision
      // (add a chargedJod column, or affirm collected) then becomes active.
      this.logger.warn(
        `[ads-wallet] OVERDRAW subsidy workspace=${workspaceId} ` +
          `billed=${charge.toFixed(4)} collected=${collected.toFixed(4)} ` +
          `shortfall=${shortfall.toFixed(4)} JOD — margin now uses collected, not billed`,
      );
      return { charged: charge, balanceAfter: ZERO, shortfallJod: shortfall };
    });
  }

  /**
   * Add funds (grant / top-up / refund / signed adjust). Idempotent on
   * externalRef: a webhook firing twice never double-credits — the whole tx
   * rolls back on the unique violation, and we return the winning row.
   */
  async credit(args: {
    type: AdsWalletCreditType;
    amountJod: Prisma.Decimal | string | number;
    description?: string | null;
    externalRef?: string | null;
  }): Promise<{ balanceAfter: Prisma.Decimal; alreadyProcessed: boolean; transaction: any }> {
    const amount = new Prisma.Decimal(args.amountJod);
    const externalRef = args.externalRef ?? null;
    const workspaceId = this.workspaceId();

    if (externalRef) {
      const existing = await this.prisma.adsWalletTransaction.findFirst({ where: { externalRef } });
      if (existing) {
        const w = await this.getOrCreateWallet();
        return { balanceAfter: w.balanceJod, alreadyProcessed: true, transaction: existing };
      }
    }

    try {
      return await this.prisma.$transaction(async (tx: any) => {
        await tx.adsWallet.upsert({
          where: { workspaceId },
          create: { balanceJod: ZERO } as any, // workspaceId injected by workspace-scope ext
          update: {},
        });
        await tx.adsWallet.updateMany({ where: { workspaceId }, data: { balanceJod: { increment: amount as any } } });
        const w = await tx.adsWallet.findFirstOrThrow({ where: { workspaceId }, select: { id: true, balanceJod: true } });
        const transaction = await tx.adsWalletTransaction.create({
          data: {
            walletId: w.id,
            type: args.type,
            amountJod: amount as any,
            balanceAfterJod: w.balanceJod as any,
            description: args.description ?? null,
            externalRef,
          },
        });
        return { balanceAfter: w.balanceJod, alreadyProcessed: false, transaction };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && externalRef) {
        const existing = await this.prisma.adsWalletTransaction.findFirst({ where: { externalRef } });
        if (existing) {
          const w = await this.getOrCreateWallet();
          return { balanceAfter: w.balanceJod, alreadyProcessed: true, transaction: existing };
        }
      }
      throw e; // e.g. a negative ADJUST that would breach the CHECK — surface it
    }
  }

  private toDto(row: any): AdsWalletTransactionDto {
    return {
      id: row.id,
      type: row.type,
      amountJod: decStr(row.amountJod),
      balanceAfterJod: decStr(row.balanceAfterJod),
      description: row.description ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
