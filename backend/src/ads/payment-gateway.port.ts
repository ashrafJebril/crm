/**
 * Gateway-agnostic payment port. StripeProvider is the first implementation; a
 * future regional gateway (PayTabs / HyperPay / Tap — which settle in JOD
 * natively) lands behind the SAME interface. The wallet must NOT be married to
 * Stripe: AdsWalletService.credit() knows nothing about gateways — it only takes
 * an externalRef for idempotency. Same discipline as AdsProviderPort: the
 * app/controller depends on this port, never on a concrete gateway.
 */
/**
 * Normalized result of verifying + parsing a top-up webhook. `handled:false`
 * means "valid signature but nothing to do" (wrong event type / unpaid / not our
 * metadata / no workspaceId) → the caller ACKs 200 so the gateway stops retrying.
 * A BAD signature does NOT produce this — parseTopupWebhook THROWS on that.
 */
export type TopupWebhookResult =
  | { handled: false }
  | { handled: true; workspaceId: string; amountJod: string; externalRef: string; description: string };

export interface PaymentGatewayPort {
  createTopupCheckout(args: {
    workspaceId: string;
    amountJod: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ checkoutUrl: string; sessionId: string }>;

  /**
   * Verify the webhook SIGNATURE (the ONLY auth for the public webhook) and
   * extract a normalized top-up. THROWS on an invalid/absent signature — the
   * caller maps that to 400 and credits nothing. Gateway details (Stripe event
   * shapes) stay inside the implementation; the wallet stays gateway-agnostic.
   */
  parseTopupWebhook(rawBody: Buffer, signature: string): TopupWebhookResult;
}

/** Nest DI token — bound to StripeProvider now, swappable later. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
