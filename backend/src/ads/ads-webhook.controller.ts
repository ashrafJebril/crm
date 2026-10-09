import {
  BadRequestException,
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { workspaceContext } from '../common/workspace-context';
import { PAYMENT_GATEWAY } from './payment-gateway.port';
import type { PaymentGatewayPort, TopupWebhookResult } from './payment-gateway.port';
import { AdsWalletService } from './ads-wallet.service';

/**
 * PUBLIC, UNAUTHENTICATED Stripe webhook — the ONLY code path that reaches
 * AdsWalletService.credit(). There is NO JWT and NO role check (Stripe can't
 * authenticate); the Stripe SIGNATURE (verified in parseTopupWebhook) is the
 * sole gate. @Public() exempts the global AuthGuard.
 *
 * The exact bytes needed for that signature check come from `req.rawBody`, which
 * the CRM's `NestFactory.create(AppModule, { rawBody: true })` (main.ts) keeps
 * for every request — no express.raw() mount, and JSON is still parsed normally
 * for the other handlers.
 *
 * With no JWT there is no AsyncLocalStorage workspace context either
 * (WorkspaceInterceptor skips tokenless requests), so the handler opens its own
 * via workspaceContext.run() from the workspaceId Stripe echoes back to us —
 * without it the workspace-scoped Prisma client has nothing to scope to and
 * credit() throws.
 *
 * Full path (global prefix /api): POST /api/ads/webhook/stripe
 */
@Controller('ads/webhook')
export class AdsWebhookController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    private readonly wallet: AdsWalletService,
  ) {}

  @Post('stripe')
  @Public()
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    // No raw bytes → the signature can't be verified at all. Fail like a bad
    // signature (400, credit nothing) rather than trusting a parsed body.
    const rawBody = req.rawBody;
    if (!rawBody) throw new BadRequestException('missing raw body');

    let result: TopupWebhookResult;
    try {
      result = this.gateway.parseTopupWebhook(rawBody, signature ?? '');
    } catch {
      // Signature verification failed — THE auth gate. Credit nothing.
      throw new BadRequestException('invalid stripe signature');
    }

    // Valid signature but nothing to do (wrong type / unpaid / not our metadata /
    // no workspaceId) → 200 so Stripe stops retrying a non-actionable event. Never
    // 5xx here — that makes Stripe retry it forever.
    if (!result.handled) return { received: true };

    // Destructured BEFORE the closure: the narrowing above doesn't survive into a
    // callback for a mutable binding.
    const { workspaceId, amountJod, description, externalRef } = result;

    // No workspace context on a webhook — open one from the workspaceId we
    // stamped at session creation so AdsWalletService (scoped client +
    // workspace-context reads) can credit. The userId is a synthetic actor: the
    // payer is Stripe, not a workspace member.
    await workspaceContext.run({ workspaceId, userId: 'stripe-webhook' }, () =>
      this.wallet.credit({
        type: 'TOPUP',
        amountJod,
        description,
        externalRef, // = session.id → credited exactly once
      }),
    );

    // A credit() FAILURE (e.g. transient DB error) is deliberately NOT caught →
    // 500 → Stripe retries → idempotent credit makes the retry safe.
    return { received: true };
  }
}
