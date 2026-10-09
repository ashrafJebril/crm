import { Prisma } from '@prisma/client';
import { AdsWalletService } from './ads-wallet.service';
import { workspaceContext } from '../common/workspace-context';
import type { PrismaService } from '../prisma/prisma.service';

const WS = 'ws_test_1';
const USER = 'user_test_1';

// Pricing env is read at CALL time (ads-pricing), so the charge in these tests is
// pinned to the DEFAULTS by clearing any operator overrides — same isolation as
// ads-pricing.spec.ts.
const ENV_KEYS = [
  'ADS_PRICE_INPUT_PER_1M',
  'ADS_PRICE_OUTPUT_PER_1M',
  'ADS_MARGIN_MULTIPLIER',
  'ADS_USD_TO_JOD',
];

/**
 * In-memory PrismaService stand-in: the two Ads wallet delegates the service
 * touches, plus a $transaction that just invokes the callback with the SAME
 * delegates (the real interactive tx client is the workspace-extended client, so
 * the calls inside and outside the tx are identical — see PrismaService).
 * updateMany honours the balance-guard in the WHERE, which is what makes the
 * overdraw branch reachable in a test.
 */
function makePrismaStub(startBalance: string) {
  const wallet = {
    id: 'wallet_1',
    workspaceId: WS,
    balanceJod: new Prisma.Decimal(startBalance),
    updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  };
  const txRows: any[] = [];
  let existingByRef: any = null;

  const delegates = {
    adsWallet: {
      upsert: jest.fn(async () => wallet),
      findUnique: jest.fn(async () => ({ balanceJod: wallet.balanceJod })),
      findFirstOrThrow: jest.fn(async () => ({ id: wallet.id, balanceJod: wallet.balanceJod })),
      updateMany: jest.fn(async (args: any) => {
        const guard = args?.where?.balanceJod?.gte;
        if (guard !== undefined && wallet.balanceJod.lessThan(guard)) return { count: 0 };
        const d = args?.data?.balanceJod;
        if (d?.decrement !== undefined) wallet.balanceJod = wallet.balanceJod.minus(d.decrement);
        else if (d?.increment !== undefined) wallet.balanceJod = wallet.balanceJod.plus(d.increment);
        else if (d !== undefined) wallet.balanceJod = new Prisma.Decimal(d);
        return { count: 1 };
      }),
    },
    adsWalletTransaction: {
      findFirst: jest.fn(async () => existingByRef),
      findMany: jest.fn(async () => txRows),
      create: jest.fn(async (args: any) => {
        const row = { id: `tx_${txRows.length + 1}`, createdAt: new Date(), ...args.data };
        txRows.push(row);
        return row;
      }),
    },
  };

  const prisma = {
    ...delegates,
    $transaction: jest.fn(async (fn: any) => fn(delegates)),
  };

  return {
    prisma,
    service: new AdsWalletService(prisma as unknown as PrismaService),
    wallet,
    txRows,
    setExistingByRef: (row: any) => {
      existingByRef = row;
    },
  };
}

// Every service method reads the workspace from the ALS store.
const inWorkspace = <T>(fn: () => Promise<T>): Promise<T> =>
  workspaceContext.run({ workspaceId: WS, userId: USER }, fn);

describe('AdsWalletService', () => {
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

  it('credit() is idempotent on externalRef via the pre-check (no second ledger row)', async () => {
    const { prisma, service, txRows, setExistingByRef } = makePrismaStub('10.0000');
    const existing = {
      id: 'tx_existing',
      type: 'TOPUP',
      amountJod: new Prisma.Decimal('10.0000'),
      balanceAfterJod: new Prisma.Decimal('10.0000'),
      externalRef: 'cs_test_123',
      createdAt: new Date(),
    };
    setExistingByRef(existing);

    const res = await inWorkspace(() =>
      service.credit({ type: 'TOPUP', amountJod: '10', externalRef: 'cs_test_123' }),
    );

    expect(res.alreadyProcessed).toBe(true);
    expect(res.transaction).toBe(existing);
    expect(res.balanceAfter.toFixed(4)).toBe('10.0000');
    // Pre-check path: the crediting transaction never runs, so nothing is written
    // and the balance is untouched — a webhook firing twice can't double-credit.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.adsWalletTransaction.create).not.toHaveBeenCalled();
    expect(txRows).toHaveLength(0);
  });

  it('debit() takes the overdraw branch when the balance is short, draining to zero', async () => {
    // Default pricing: 100,000 input tokens => usdCost 0.30 => 0.30 * 2.0 * 0.72 =
    // 0.4320 JOD charged against a 0.2000 balance => overdraw.
    const { service, wallet, txRows } = makePrismaStub('0.2000');

    const res = await inWorkspace(() =>
      service.debit({
        inputTokens: 100_000,
        outputTokens: 0,
        model: 'claude-sonnet-4-5-20250929',
        description: 'overdraw case',
      }),
    );

    expect(res.charged.toFixed(4)).toBe('0.4320');
    expect(res.balanceAfter.toFixed(4)).toBe('0.0000');
    expect(res.shortfallJod.toFixed(4)).toBe('0.2320');
    expect(wallet.balanceJod.toFixed(4)).toBe('0.0000');

    // amountJod == what actually LEFT the wallet (-collected), never the billed
    // charge: SUM(amountJod) must still equal balanceAfterJod (0).
    expect(txRows).toHaveLength(1);
    const row = txRows[0];
    expect(row.type).toBe('DEBIT');
    expect(row.amountJod.toFixed(4)).toBe('-0.2000');
    expect(row.balanceAfterJod.toFixed(4)).toBe('0.0000');
    // The subsidy is legible on the row: full charge + collected + shortfall, and the
    // cost basis holds the FULL cost incurred (we made the API call).
    expect(row.breakdownJson.overdraw).toBe(true);
    expect(row.breakdownJson.chargedJod).toBe('0.4320');
    expect(row.breakdownJson.collectedJod).toBe('0.2000');
    expect(row.breakdownJson.shortfallJod).toBe('0.2320');
    expect(new Prisma.Decimal(row.costBasisUsd).toFixed(4)).toBe('0.3000');
  });

  it('debit() takes the full-charge path when the balance covers it', async () => {
    const { service, wallet, txRows } = makePrismaStub('1.0000');

    const res = await inWorkspace(() =>
      service.debit({ inputTokens: 100_000, outputTokens: 0, model: 'claude-sonnet-4-5-20250929' }),
    );

    expect(res.charged.toFixed(4)).toBe('0.4320');
    expect(res.balanceAfter.toFixed(4)).toBe('0.5680');
    expect(res.shortfallJod.toFixed(4)).toBe('0.0000');
    expect(wallet.balanceJod.toFixed(4)).toBe('0.5680');
    expect(txRows[0].amountJod.toFixed(4)).toBe('-0.4320');
    expect(txRows[0].breakdownJson.overdraw).toBeUndefined();
  });
});
