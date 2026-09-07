import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import type { Request } from "express";

/**
 * Verifies Zernio's `X-Zernio-Signature` (lowercase hex HMAC-SHA256 of the raw
 * body, keyed by ZERNIO_WEBHOOK_SECRET) before any webhook handler runs, so
 * forged inbound payloads can't inject messages. Fails closed if the secret is
 * unset. The legacy `X-Late-Signature` header (Zernio was formerly Getlate) is
 * accepted as a fallback.
 *
 * Requires `rawBody: true` on the Nest app (main.ts).
 */
@Injectable()
export class ZernioWebhookSignatureGuard implements CanActivate {
  private readonly log = new Logger(ZernioWebhookSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer }>();
    const secret = process.env.ZERNIO_WEBHOOK_SECRET;
    if (!secret) {
      this.log.error("Rejecting Zernio webhook: ZERNIO_WEBHOOK_SECRET not set");
      throw new ForbiddenException("Zernio webhook verification unavailable");
    }
    const header = (
      req.header("x-zernio-signature") ??
      req.header("x-late-signature") ??
      ""
    ).replace(/^sha256=/, "");
    if (!req.rawBody || !header) {
      throw new ForbiddenException("Missing Zernio webhook signature");
    }
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      // TEMPORARY DIAGNOSTIC — remove once the mismatch is explained.
      // Logs no secret: only digests, lengths and header names, plus the
      // candidate schemes a provider might use, so one live delivery says
      // which (if any) matches.
      const hmac = (key: string, data: crypto.BinaryLike) =>
        crypto.createHmac("sha256", key).update(data).digest("hex");
      const ts =
        req.header("x-zernio-timestamp") ??
        req.header("x-zernio-request-timestamp") ??
        req.header("x-late-timestamp") ??
        "";
      const b64 = crypto
        .createHmac("sha256", secret)
        .update(req.rawBody)
        .digest("base64");
      this.log.warn(
        "Zernio signature mismatch — diagnostic: " +
          JSON.stringify({
            headerLen: header.length,
            headerPrefix: header.slice(0, 12),
            expectedPrefix: expected.slice(0, 12),
            bodyBytes: req.rawBody.length,
            secretLen: secret.length,
            matches: {
              hexOverBody: false,
              base64OverBody: b64 === header,
              hexOverTimestampDotBody: ts
                ? hmac(secret, `${ts}.${req.rawBody.toString("utf8")}`) === header
                : "no-timestamp-header",
              hexOverBodyString: hmac(secret, req.rawBody.toString("utf8")) === header,
            },
            zernioHeaders: Object.keys(req.headers).filter((h) =>
              h.includes("zernio") || h.includes("late") || h.includes("signature"),
            ),
            contentType: req.header("content-type") ?? null,
            eventId: req.header("x-zernio-event-id") ?? null,
            bodyHead: req.rawBody.toString("utf8").slice(0, 120),
          }),
      );
      throw new ForbiddenException("Invalid Zernio webhook signature");
    }
    return true;
  }
}
