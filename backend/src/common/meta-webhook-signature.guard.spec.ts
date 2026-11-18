import * as crypto from "node:crypto";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { MetaWebhookSignatureGuard } from "./meta-webhook-signature.guard";

function ctx(url: string, body: string, secret: string | null): ExecutionContext {
  const raw = Buffer.from(body);
  const sig = secret
    ? "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex")
    : undefined;
  const req = { originalUrl: url, rawBody: raw, header: (n: string) => (n === "x-hub-signature-256" ? sig : undefined) };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("MetaWebhookSignatureGuard", () => {
  const OLD = { ...process.env };
  const guard = new MetaWebhookSignatureGuard();
  beforeEach(() => {
    process.env = { ...OLD, META_APP_SECRET: "main", META_APP_SECRET_WA: "wa" };
    delete process.env.META_TECH_PROVIDER_ENABLED;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("accepts WhatsApp webhooks signed by either app", () => {
    expect(guard.canActivate(ctx("/api/webhooks/whatsapp", "{}", "wa"))).toBe(true);
    expect(guard.canActivate(ctx("/api/webhooks/whatsapp", "{}", "main"))).toBe(true);
  });

  it("accepts /webhooks/meta only with the main secret", () => {
    expect(guard.canActivate(ctx("/api/webhooks/meta", "{}", "main"))).toBe(true);
    expect(() => guard.canActivate(ctx("/api/webhooks/meta", "{}", "wa"))).toThrow(ForbiddenException);
  });

  it("rejects bad or missing signatures", () => {
    expect(() => guard.canActivate(ctx("/api/webhooks/whatsapp", "{}", "evil"))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx("/api/webhooks/whatsapp", "{}", null))).toThrow(ForbiddenException);
  });

  it("fails closed when no secret is configured", () => {
    delete process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET_WA;
    expect(() => guard.canActivate(ctx("/api/webhooks/whatsapp", "{}", "wa"))).toThrow(ForbiddenException);
  });
});
