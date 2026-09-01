import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";

/**
 * Outbound bridge to the Kewy AI service.
 *
 * WHY THIS IS FIRE-AND-FORGET
 * ---------------------------
 * This is called from `ingestInbound()`, which sits on the critical path of
 * every WhatsApp webhook. Meta redelivers on any non-200 or timeout, so if the
 * AI service is slow or down and we awaited it, we would either duplicate the
 * message on redelivery or lose the delivery entirely. The inbox must keep
 * working with the AI switched off, unreachable, or on fire — it is an
 * enhancement to the thread, never a dependency of it.
 *
 * So: bounded timeout, every failure swallowed and logged, never rethrown.
 *
 * WHY HMAC RATHER THAN A BEARER TOKEN
 * -----------------------------------
 * Mirrors the direction we already trust: `hjz-webhooks.service.ts` verifies an
 * inbound shared secret in constant time. Signing the body (not just presenting
 * a token) means a leaked log line cannot be replayed against a different
 * payload.
 */
@Injectable()
export class AiBridgeService {
  private readonly log = new Logger(AiBridgeService.name);

  /** Bounded so a hung AI service cannot stall the webhook handler. */
  private static readonly TIMEOUT_MS = 4_000;

  private config() {
    const url = process.env.KEWY_AI_URL;
    const secret = process.env.KEWY_AI_WEBHOOK_SECRET;
    // Absent config means "the AI is not wired up here" — a normal state for
    // every workspace that has not bought the module. Not an error.
    if (!url || !secret) return null;
    return { url: url.replace(/\/$/, ""), secret };
  }

  /** Is the bridge configured at all? Lets callers skip work entirely. */
  isConfigured(): boolean {
    return this.config() !== null;
  }

  /**
   * Tell the AI service a customer message arrived.
   *
   * `windowOpen` is the caller's problem, not ours: Meta only permits free-text
   * replies within 24h of the customer's last inbound message. Outside it the
   * agent may only send an approved template, so it has to be told which mode
   * it is in — otherwise it composes a reply that silently fails to deliver.
   */
  async notifyInbound(payload: {
    workspaceId: string;
    conversationId: string;
    contactId: string;
    channel: string;
    messageId: string | null;
    body: string;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    windowOpen: boolean;
    receivedAt: string;
  }): Promise<void> {
    const cfg = this.config();
    if (!cfg) return;

    const raw = JSON.stringify({ event: "message.received", ...payload });
    const signature = crypto.createHmac("sha256", cfg.secret).update(raw).digest("hex");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AiBridgeService.TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.url}/ai/inbound`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Name mirrors the inbound hjz convention (x-marketing-secret).
          "x-kewy-signature": signature,
        },
        body: raw,
        signal: controller.signal,
      });
      if (!res.ok) {
        this.log.warn(
          `AI bridge rejected conv=${payload.conversationId}: ${res.status} ${res.statusText}`,
        );
      }
    } catch (e) {
      // Includes the abort. Deliberately terminal: the message is already
      // stored and visible in the inbox, so a human can still answer it.
      this.log.warn(
        `AI bridge unreachable for conv=${payload.conversationId}: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Constant-time check of the signature on a reply coming BACK from the AI
   * service. Same discipline as HjzWebhooksService.verifySecret.
   */
  verifyInboundSignature(rawBody: string, provided: string | undefined): boolean {
    const cfg = this.config();
    if (!cfg || !provided) return false;
    const expected = crypto.createHmac("sha256", cfg.secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    // timingSafeEqual throws on a length mismatch, which is itself a leak of
    // information — compare lengths first and bail uniformly.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
