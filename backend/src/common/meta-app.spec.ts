import * as crypto from "node:crypto";
import {
  metaWebhookSecrets,
  parseSignedRequest,
  techProviderEnabled,
  whatsappApp,
} from "./meta-app";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: object, secret: string): string {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${sig}.${body}`;
}

describe("meta-app config", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = { ...OLD };
    delete process.env.META_TECH_PROVIDER_ENABLED;
    process.env.META_APP_ID = "main-id";
    process.env.META_APP_SECRET = "main-secret";
    process.env.META_APP_ID_WA = "wa-id";
    process.env.META_APP_SECRET_WA = "wa-secret";
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("is off unless META_TECH_PROVIDER_ENABLED is 'true'", () => {
    expect(techProviderEnabled()).toBe(false);
    process.env.META_TECH_PROVIDER_ENABLED = "1";
    expect(techProviderEnabled()).toBe(false);
    process.env.META_TECH_PROVIDER_ENABLED = "true";
    expect(techProviderEnabled()).toBe(true);
  });

  it("WhatsApp keeps the legacy WA app while the switch is off", () => {
    expect(whatsappApp()).toEqual({ appId: "wa-id", appSecret: "wa-secret" });
  });

  it("WhatsApp uses the single main app once the switch is on", () => {
    process.env.META_TECH_PROVIDER_ENABLED = "true";
    expect(whatsappApp()).toEqual({ appId: "main-id", appSecret: "main-secret" });
  });

  it("falls back to the main app when no WA app is configured", () => {
    delete process.env.META_APP_ID_WA;
    delete process.env.META_APP_SECRET_WA;
    expect(whatsappApp()).toEqual({ appId: "main-id", appSecret: "main-secret" });
  });

  it("accepts both secrets on the WhatsApp webhook, main only on /webhooks/meta", () => {
    expect(metaWebhookSecrets("whatsapp")).toEqual(["wa-secret", "main-secret"]);
    process.env.META_TECH_PROVIDER_ENABLED = "true";
    expect(metaWebhookSecrets("whatsapp")).toEqual(["main-secret", "wa-secret"]);
    expect(metaWebhookSecrets("meta")).toEqual(["main-secret"]);
  });

  it("drops unset and duplicate secrets", () => {
    process.env.META_APP_SECRET_WA = "main-secret";
    expect(metaWebhookSecrets("whatsapp")).toEqual(["main-secret"]);
    delete process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET_WA;
    expect(metaWebhookSecrets("whatsapp")).toEqual([]);
  });
});

describe("parseSignedRequest", () => {
  it("returns the payload when the signature matches", () => {
    const sr = sign({ algorithm: "HMAC-SHA256", user_id: "42", issued_at: 1 }, "s3cret");
    expect(parseSignedRequest(sr, ["other", "s3cret"])).toMatchObject({ user_id: "42" });
  });

  it("rejects a bad signature", () => {
    const sr = sign({ algorithm: "HMAC-SHA256", user_id: "42" }, "wrong");
    expect(parseSignedRequest(sr, ["s3cret"])).toBeNull();
  });

  it("rejects a non-HMAC-SHA256 algorithm", () => {
    const sr = sign({ algorithm: "none", user_id: "42" }, "s3cret");
    expect(parseSignedRequest(sr, ["s3cret"])).toBeNull();
  });

  it("rejects garbage and empty secret lists", () => {
    expect(parseSignedRequest("nope", ["s3cret"])).toBeNull();
    expect(parseSignedRequest(undefined, ["s3cret"])).toBeNull();
    const sr = sign({ algorithm: "HMAC-SHA256", user_id: "42" }, "s3cret");
    expect(parseSignedRequest(sr, [])).toBeNull();
  });
});
