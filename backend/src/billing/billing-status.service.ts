import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { isPaymentLocked, PAYMENT_GRACE_DAYS } from "./payment-lock";
import { lowBalanceJod, STATUS_CACHE_MS } from "./billing-constants";
import { featuresOf, planKeyOf, type Feature, type PlanKey } from "./plan-catalog";
import { UsageService } from "./usage.service";
import { WalletService } from "./wallet.service";

const DAY_MS = 86_400_000;
/** The usage window shown in the status (rolling, like the allowances' period). */
export const STATUS_USAGE_DAYS = 30;

export type Banner = "grace" | "low_balance";

export interface BillingStatus {
  billedBy: "kewy";
  plan: { key: PlanKey | null; name: string };
  overridden: boolean;
  features: Feature[];
  payment: { dueSince: string | null; locksAt: string | null; locked: boolean };
  banners: Banner[];
  /** Only with billing.view. */
  wallet?: { balanceJod: string; lowBalance: boolean };
  usage?: { from: string; to: string; meters: { meter: string; used: number; allowance: number | null }[] };
}

/** The status without the money and usage parts (members without billing.view). */
export function reduceStatus(s: BillingStatus): BillingStatus {
  const { wallet: _w, usage: _u, ...rest } = s;
  return { ...rest, banners: rest.banners.filter((b) => b !== "low_balance") };
}

/**
 * Banners (R11/R12 re-scoped: Kewy has no trial in this CRM, so no trial
 * banner): `grace` while a payment is due and not yet locked; `low_balance`
 * when the wallet is below the ads minimum.
 */
export function bannersFor(o: { dueSince: Date | null; locked: boolean; balance: Prisma.Decimal | null; threshold: Prisma.Decimal }): Banner[] {
  const out: Banner[] = [];
  if (o.dueSince && !o.locked) out.push("grace");
  if (o.balance && o.balance.lessThan(o.threshold)) out.push("low_balance");
  return out;
}

/**
 * SP-28 credit status on Kewy data (`GET /billing/status`): plan, features,
 * payment-lock clock (the existing lock, R11), wallet and usage. Cached 30 s
 * per workspace; members without billing.view get the reduced payload.
 */
@Injectable()
export class BillingStatusService {
  private readonly cache = new Map<string, { at: number; status: BillingStatus }>();
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly usage: UsageService,
  ) {}

  async status(workspaceId: string, canViewBilling: boolean): Promise<BillingStatus> {
    const full = await this.full(workspaceId);
    return canViewBilling ? full : reduceStatus(full);
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  private async full(workspaceId: string): Promise<BillingStatus> {
    const now = this.now();
    const hit = this.cache.get(workspaceId);
    if (hit && now.getTime() - hit.at < STATUS_CACHE_MS) return hit.status;

    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId },
      select: { plan: true, planOverriddenAt: true, paymentDueSince: true },
    });
    const plan = ws?.plan ?? "free";
    const dueSince = ws?.paymentDueSince ?? null;
    const locked = isPaymentLocked(dueSince, now);
    const balance = await this.wallet.balance(workspaceId);
    const threshold = lowBalanceJod();
    const from = new Date(now.getTime() - STATUS_USAGE_DAYS * DAY_MS);
    const usage = await this.usage.summary(workspaceId, from, now, plan);
    const status: BillingStatus = {
      billedBy: "kewy",
      plan: { key: planKeyOf(plan), name: plan },
      overridden: !!ws?.planOverriddenAt,
      features: featuresOf(plan),
      payment: {
        dueSince: dueSince ? dueSince.toISOString() : null,
        locksAt: dueSince ? new Date(dueSince.getTime() + PAYMENT_GRACE_DAYS * DAY_MS).toISOString() : null,
        locked,
      },
      banners: bannersFor({ dueSince, locked, balance, threshold }),
      wallet: { balanceJod: balance.toFixed(4), lowBalance: balance.lessThan(threshold) },
      usage,
    };
    this.cache.set(workspaceId, { at: now.getTime(), status });
    return status;
  }
}
