import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { JwtPayload } from "../auth/auth.guard";
import { CurrentWorkspace } from "../common/current-workspace.decorator";
import { PermissionService, type EffectiveRole } from "../permissions/permission.service";
import { billingError } from "./billing-errors";
import { BillingStatusService } from "./billing-status.service";
import { publicCatalog } from "./plan-catalog";
import { UsageService } from "./usage.service";
import { WalletService } from "./wallet.service";
import { PlanService } from "./plan.service";

type Req = Request & { user?: JwtPayload; permissions?: EffectiveRole };

const DAY_MS = 86_400_000;

/** `?from&to` as ISO dates or instants; default the last 30 days. */
function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw billingError("billing.invalid_range");
  return { from: start, to: end };
}

/**
 * SP-28 billing, re-scoped: read-only over Kewy data (no checkout, invoices
 * or Stripe). Routes (permission-map.ts): status `authenticated` (reduced
 * without billing.view), the rest `billing.view`.
 */
@Controller("billing")
export class BillingController {
  constructor(
    private readonly status: BillingStatusService,
    private readonly wallet: WalletService,
    private readonly usage: UsageService,
    private readonly perms: PermissionService,
    private readonly plans: PlanService,
  ) {}

  @Get("status")
  getStatus(@CurrentWorkspace() workspaceId: string, @Req() req: Req) {
    const u = req.user;
    // Super-admin sees all; impersonation never sees billing (SP-25 blocks billing.*).
    const canView = u?.isSuperAdmin === true || (u?.impersonating !== true && this.perms.can(req.permissions, "billing.view"));
    return this.status.status(workspaceId, canView);
  }

  @Get("catalog")
  catalog() {
    return publicCatalog();
  }

  @Get("wallet")
  async getWallet(@CurrentWorkspace() workspaceId: string) {
    return { balanceJod: (await this.wallet.balance(workspaceId)).toFixed(4) };
  }

  @Get("wallet/ledger")
  ledger(@CurrentWorkspace() workspaceId: string, @Query("cursor") cursor?: string) {
    return this.wallet.ledger(workspaceId, typeof cursor === "string" && cursor ? cursor : null);
  }

  @Get("usage")
  async getUsage(@CurrentWorkspace() workspaceId: string, @Query("from") from?: string, @Query("to") to?: string) {
    const r = parseRange(from, to);
    return this.usage.summary(workspaceId, r.from, r.to, (await this.plans.planOf(workspaceId)).plan);
  }

  @Get("usage/daily")
  async daily(
    @CurrentWorkspace() workspaceId: string,
    @Query("meter") meter: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const r = parseRange(from, to);
    // Days are the workspace's local days (its stored timezone).
    return this.usage.daily(workspaceId, String(meter ?? ""), r.from, r.to, await this.usage.timezoneOf(workspaceId));
  }
}
