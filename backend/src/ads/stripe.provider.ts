import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Stripe from 'stripe';
import type { PaymentGatewayPort, TopupWebhookResult } from './payment-gateway.port';

/**
 * Stripe implementation of PaymentGatewayPort. Credentials come via the
 * CONSTRUCTOR with env fallback, resolved LAZILY so a missing STRIPE_SECRET_KEY
 * fails the REQUEST, not API boot — same discipline as PipeboardProvider /
 * AdsChatService. Card data never touches Kewy Marketing: we create a HOSTED Checkout
 * Session and return its URL; the customer pays on Stripe's page.
 */
@Injectable()
export class StripeProvider implements PaymentGatewayPort {
  private readonly cfgSecretKey?: string;
  private readonly cfgWebhookSecret?: string;
  private client?: Stripe;
  private readonly log = new Logger(StripeProvider.name);

  constructor(cfg?: { secretKey?: string; webhookSecret?: string }) {
    this.cfgSecretKey = cfg?.secretKey;
    this.cfgWebhookSecret = cfg?.webhookSecret;
  }

  private resolveSecretKey(): string {
    const k = this.cfgSecretKey ?? process.env.STRIPE_SECRET_KEY;
    if (!k) throw new Error('StripeProvider: no secret key (pass cfg.secretKey or set STRIPE_SECRET_KEY)');
    return k;
  }

  /** Webhook-signature secret. UNUSED until commit (b) verifies webhooks — kept
   *  here so the whole Stripe credential surface lives in ONE place. */
  resolveWebhookSecret(): string {
    const s = this.cfgWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!s) throw new Error('StripeProvider: no webhook secret (pass cfg.webhookSecret or set STRIPE_WEBHOOK_SECRET)');
    return s;
  }

  private stripe(): Stripe {
    // Lazy — constructing Stripe reads the key; do it on first use, not at boot.
    if (!this.client) this.client = new Stripe(this.resolveSecretKey());
    return this.client;
  }

  async createTopupCheckout(args: {
    workspaceId: string;
    amountJod: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ checkoutUrl: string; sessionId: string }> {
    // JOD is a THREE-decimal currency: smallest unit = JOD × 1000 (fils), NOT
    // × 100. The contract caps top-ups at 2 decimals, so this is always a
    // multiple of 10 (Stripe's three-decimal-currency requirement).
    const unitAmount = Math.round(Number(args.amountJod) * 1000);

    const session = await this.stripe().checkout.sessions.create({
      mode: 'payment',
      // workspaceId in BOTH client_reference_id AND metadata. The webhook (commit
      // b) runs with NO tenant context — no JWT, no currentTenant() — so this is
      // the ONLY way it can know which wallet to credit. Without it the payment
      // is unattributable. The sessionId also becomes credit()'s externalRef
      // later, for idempotency.
      client_reference_id: args.workspaceId,
      metadata: { workspaceId: args.workspaceId, amountJod: args.amountJod, kind: 'ads_wallet_topup' },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'jod',
            unit_amount: unitAmount,
            product_data: { name: 'Kewy Marketing Ads Assistant — wallet top-up' },
          },
        },
      ],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    });

    if (!session.url) throw new Error('StripeProvider: Checkout Session returned no URL');
    return { checkoutUrl: session.url, sessionId: session.id };
  }

  parseTopupWebhook(rawBody: Buffer, signature: string): TopupWebhookResult {
    // THE authentication for the public webhook — no JWT, no RBAC. constructEvent
    // THROWS on a bad/missing signature; the controller maps that to 400 and
    // credits nothing. Without it, any POST could credit a wallet for free.
    const event = this.stripe().webhooks.constructEvent(
      rawBody,
      signature,
      this.resolveWebhookSecret(),
    );

    // Credit on exactly ONE thing: a Checkout Session that actually got paid.
    if (event.type !== 'checkout.session.completed') return { handled: false };
    const session = event.data.object as Stripe.Checkout.Session;

    // GAP (currently moot — do NOT add a handler yet): we credit ONLY on a
    // synchronously-'paid' session. The UAE account enables card / Apple Pay /
    // Google Pay / Link only — all SYNCHRONOUS — so payment_status is 'paid'
    // here every time. The moment ANY async payment method is enabled (bank
    // debits, vouchers, etc.), a real payment can arrive 'unpaid'/'processing'
    // now and settle later via `checkout.session.async_payment_succeeded`, which
    // we do NOT handle — the customer would pay and NEVER be credited. Enabling
    // any async method ⇒ MUST add an async_payment_succeeded branch (same
    // credit, keyed on the same session.id externalRef).
    if (session.payment_status !== 'paid') return { handled: false };
    if (session.metadata?.kind !== 'ads_wallet_topup') return { handled: false };

    // No tenant context on a webhook — workspaceId is ONLY what we stamped at
    // session creation (commit a): metadata.workspaceId, else client_reference_id.
    const workspaceId = session.metadata?.workspaceId ?? session.client_reference_id ?? undefined;
    if (!workspaceId) {
      this.log.error(`[stripe-webhook] paid topup with NO workspaceId (session ${session.id}) — ignoring (200)`);
      return { handled: false };
    }
    if (session.amount_total == null) {
      this.log.error(`[stripe-webhook] paid topup with null amount_total (session ${session.id}) — ignoring (200)`);
      return { handled: false };
    }

    // Trust what Stripe ACTUALLY charged (amount_total = fils = JOD × 1000), NOT
    // the metadata amount we merely requested. Decimal math (no float). If they
    // disagree, log loudly and credit the CHARGED amount.
    const amountJod = new Prisma.Decimal(session.amount_total).dividedBy(1000).toFixed(3);
    const requested = session.metadata?.amountJod;
    if (requested && !new Prisma.Decimal(requested).equals(amountJod)) {
      this.log.warn(
        `[stripe-webhook] amount mismatch (session ${session.id}): requested=${requested} charged=${amountJod} — crediting CHARGED`,
      );
    }

    // externalRef = the Checkout Session id: the PAYMENT's identity, stable
    // across every retry/event → idempotency keys on the payment, not the notice.
    return { handled: true, workspaceId, amountJod, externalRef: session.id, description: 'شحن رصيد عبر سترايب' };
  }
}
