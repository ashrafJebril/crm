import { Global, Module } from "@nestjs/common";
import { PaymentLockService } from "./payment-lock.service";

@Global()
@Module({ providers: [PaymentLockService], exports: [PaymentLockService] })
export class BillingModule {}
