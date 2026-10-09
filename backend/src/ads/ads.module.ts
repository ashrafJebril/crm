import { Module } from '@nestjs/common';
import { ADS_PROVIDER } from './ads-provider.port';
import type { AdsProviderPort } from './ads-provider.port';
import { PipeboardProvider } from './pipeboard.provider';
import { PipeboardAllowlistGuard } from './pipeboard-allowlist.guard';
import { PAYMENT_GATEWAY } from './payment-gateway.port';
import { StripeProvider } from './stripe.provider';
import { AdsChatService } from './ads-chat.service';
import { AdsChatSessionService } from './ads-chat-session.service';
import { AdsPendingActionService } from './ads-pending-action.service';
import { AdsWalletService } from './ads-wallet.service';
import { AdsController } from './ads.controller';
import { AdsWebhookController } from './ads-webhook.controller';

/**
 * Ads Assistant module — the Salma chat surface, the JOD wallet, and the
 * approval-gated Meta write path.
 *
 * Binds ADS_PROVIDER to a default env-configured PipeboardProvider via a factory
 * (not useClass — the provider's constructor takes an optional config object, not
 * injectable deps). StripeProvider and AdsChatService are bound the same way and
 * for the same reason.
 *
 * PrismaService needs no import: PrismaModule is @Global (prisma/prisma.module.ts),
 * so the services resolve it like every other CRM module's do.
 */
@Module({
  controllers: [AdsController, AdsWebhookController],
  providers: [
    { provide: ADS_PROVIDER, useFactory: () => new PipeboardProvider() },
    // StripeProvider's constructor takes an optional cfg (keys), not injectable
    // deps — bind via factory, same reason as ADS_PROVIDER / AdsChatService.
    { provide: PAYMENT_GATEWAY, useFactory: () => new StripeProvider() },
    // AdsChatService receives the Port via the ADS_PROVIDER token; its optional
    // cfg (API key) constructor arg isn't Nest-injectable, so bind via factory.
    {
      provide: AdsChatService,
      useFactory: (provider: AdsProviderPort) => new AdsChatService(provider),
      inject: [ADS_PROVIDER],
    },
    AdsChatSessionService,
    // The passthrough write gate — pending-action store + the sole write-execute
    // path (approveAndExecute). Injects PrismaService + ADS_PROVIDER.
    AdsPendingActionService,
    // The wallet — ledger + atomic debit + pricing. Injects the @Global
    // PrismaService directly (no factory).
    AdsWalletService,
    // Boot-time allowlist cross-check (refuses to boot on a too-loose disagreement
    // between PIPEBOARD_UNGATED and Pipeboard's readOnlyHint annotations).
    PipeboardAllowlistGuard,
  ],
  // NOTHING is exported, deliberately — the module is a closed surface reached
  // only through its two controllers:
  //  • ADS_PROVIDER: exporting the raw port would let any future module inject it
  //    and call callRaw('create_campaign', …) with zero gate and no approval — a
  //    second, un-greppable write path.
  //  • AdsPendingActionService: approveAndExecute is the ONE write-execution
  //    path; ads-pending-action.service.ts states this non-export as half of the
  //    guarantee (the other half being module-private executeGatedTool).
  //  • AdsWalletService: credit() MINTS balance. It must stay reachable only from
  //    the signature-verified Stripe webhook in this module.
  //  • PAYMENT_GATEWAY / AdsChatService: hjz exported these for a webhook that
  //    lived outside the module; here the webhook controller is in-module, so the
  //    exports would buy nothing and only widen the surface.
  // Every in-module consumer resolves these internally.
})
export class AdsModule {}
