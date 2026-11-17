import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WalletEmptyError, billingError } from "./billing-errors";
import { LEDGER_PAGE } from "./billing-constants";
import { usageKey } from "./usage.service";
import type { Meter } from "./plan-catalog";

const ZERO = new Prisma.Decimal(0);
const dec = (d: Prisma.Decimal | null | undefined) => (d ?? ZERO).toFixed(4);

export interface DebitInput {
  meter: Exclude<Meter, "ads_ai">;
  amountJod: Prisma.Decimal | string | number;
  sourceKind: string;
  sourceId: string;
  description?: string | null;
}

export interface DebitResult {
  replayed: boolean;
  walletTxId: string | null;
  balanceAfterJod: string;
}

/**
 * SP-28 (R2): the workspace wallet is the existing AdsWallet tables, with no
 * second balance. This facade adds metered debits for the new meters and
 * puts the existing credit path behind one name.
 *
 * - `debit` refuses rather than overdraws (402 WALLET_EMPTY): the balance
 *   only moves through a conditional decrement (`balanceJod >= amount` in
 *   the WHERE), so concurrent debits can never take it below zero; the DB
 *   CHECK `AdsWallet_balanceJod_non_negative` stays as the backstop.
 * - It is idempotent per source: the `UsageEvent` with the source's key is
 *   written in the same transaction, so a replay returns the first result
 *   and charges nothing; a refused debit rolls back and records no usage.
 * - The ads meter keeps its own drain-to-zero path in AdsWalletService.
 * - No credit here: AdsWalletService.credit mints balance and stays reachable
 *   only from the signature-verified Stripe webhook in AdsModule (its own
 *   invariant). With Kewy as the biller there is no new top-up path.
 * - R6: nothing calls `debit` in v1 (usage is metered, never charged).
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(private readonly prisma: PrismaService) {}

  async balance(workspaceId: string): Promise<Prisma.Decimal> {
    const w = await this.prisma.adsWallet.findFirst({ where: { workspaceId }, select: { balanceJod: true } });
    return w?.balanceJod ?? ZERO;
  }

  /** The ledger, newest first, LEDGER_PAGE rows per page (`cursor` = the last row's id). */
  async ledger(workspaceId: string, cursor?: string | null) {
    const rows = await this.prisma.adsWalletTransaction.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LEDGER_PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, type: true, meter: true, amountJod: true, balanceAfterJod: true, description: true, createdAt: true },
    });
    const page = rows.slice(0, LEDGER_PAGE);
    return {
      items: page.map((r) => ({
        id: r.id,
        type: r.type,
        meter: r.meter ?? null,
        amountJod: dec(r.amountJod),
        balanceAfterJod: dec(r.balanceAfterJod),
        description: r.description ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: rows.length > LEDGER_PAGE ? page[page.length - 1]?.id ?? null : null,
    };
  }

  async debit(workspaceId: string, input: DebitInput): Promise<DebitResult> {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(input.amountJod);
    } catch {
      throw billingError("billing.invalid_amount");
    }
    if (!amount.isFinite() || amount.lte(0) || amount.decimalPlaces() > 4) throw billingError("billing.invalid_amount");
    const key = usageKey(input.meter, input.sourceKind, input.sourceId);
    const replay = async (): Promise<DebitResult> => {
      const ev = await this.prisma.usageEvent.findFirst({ where: { workspaceId, idempotencyKey: key }, select: { walletTxId: true } });
      return { replayed: true, walletTxId: ev?.walletTxId ?? null, balanceAfterJod: dec(await this.balance(workspaceId)) };
    };

    if (await this.prisma.usageEvent.findFirst({ where: { workspaceId, idempotencyKey: key }, select: { id: true } })) return replay();

    try {
      return await this.prisma.$transaction(async (tx: any) => {
        // The usage row first: its unique key serialises two debits of one source.
        const ev = await tx.usageEvent.create({
          data: { workspaceId, meter: input.meter, qty: 1, sourceKind: input.sourceKind, sourceId: input.sourceId, idempotencyKey: key },
        });
        await tx.adsWallet.upsert({ where: { workspaceId }, create: { workspaceId, balanceJod: ZERO }, update: {} });
        const applied = await tx.adsWallet.updateMany({
          where: { workspaceId, balanceJod: { gte: amount } },
          data: { balanceJod: { decrement: amount } },
        });
        if (applied.count !== 1) {
          const w = await tx.adsWallet.findFirst({ where: { workspaceId }, select: { balanceJod: true } });
          // Rolls back the usage row too: a refused debit leaves nothing behind.
          throw new WalletEmptyError(dec(w?.balanceJod), amount.toFixed(4));
        }
        const w = await tx.adsWallet.findFirst({ where: { workspaceId }, select: { id: true, balanceJod: true } });
        const row = await tx.adsWalletTransaction.create({
          data: {
            workspaceId,
            walletId: w.id,
            type: "DEBIT",
            meter: input.meter,
            amountJod: amount.negated(),
            balanceAfterJod: w.balanceJod,
            description: input.description ?? null,
          },
        });
        await tx.usageEvent.update({ where: { id: ev.id }, data: { walletTxId: row.id } });
        return { replayed: false, walletTxId: row.id as string, balanceAfterJod: dec(w.balanceJod) };
      });
    } catch (e) {
      // A concurrent debit of the same source won the usage key: that one charged.
      if ((e as { code?: string })?.code === "P2002") return replay();
      throw e;
    }
  }
}
