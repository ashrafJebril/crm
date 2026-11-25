import { Global, Module } from "@nestjs/common";
import { PermissionsModule } from "../permissions/permissions.module";
import { BillingController } from "./billing.controller";
import { BillingStatusService } from "./billing-status.service";
import { PaymentLockService } from "./payment-lock.service";
import { PlanFeatureGuard } from "./plan-feature.guard";
import { PlanService } from "./plan.service";
import { UsageService } from "./usage.service";
import { WalletService } from "./wallet.service";

/**
 * Global: the payment lock (every entry point), and SP-28's re-scoped billing
 * on Kewy data: plan lookup and gate, usage metering (other modules record
 * through UsageService), the wallet facade over AdsWallet, credit status.
 */
@Global()
@Module({
  imports: [PermissionsModule],
  controllers: [BillingController],
  providers: [PaymentLockService, PlanService, PlanFeatureGuard, UsageService, WalletService, BillingStatusService],
  exports: [PaymentLockService, PlanService, PlanFeatureGuard, UsageService, WalletService, BillingStatusService],
})
export class BillingModule {}
