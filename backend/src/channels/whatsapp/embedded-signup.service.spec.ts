import { Logger } from "@nestjs/common";
import { makeFakePrisma } from "../test-prisma";
import { channelErrorKey } from "../channel-errors";
import { MetaGraphClient } from "./meta-graph.client";
import { EmbeddedSignupService, embeddedSignupConfig } from "./embedded-signup.service";
import { fakeGraph, graphError, isolateEnv, META_ENV, type GraphHandler } from "./test-graph";

const TOKEN = "BIZ-TOKEN-B-0123456789";

const integA = {
  id: "I-A",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "meta",
  pageId: "pn-A",
  pageName: "+962 7 9000 0001",
  accessToken: "TOKEN-A",
  raw: JSON.stringify({ wabaId: "waba-A", verifyToken: "v" }),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};
const chanA = {
  id: "chi_I-A",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "meta",
  externalId: "pn-A",
  displayName: "+962 7 9000 0001",
  phoneNumber: "+962790000001",
  status: "active",
  isDefault: true,
  integrationId: "I-A",
  config: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const okHandlers = (): GraphHandler[] => [
  ["/oauth/access_token", { body: { access_token: TOKEN } }],
  [/POST \S+\/waba-[A-Z]\/subscribed_apps/, { body: { success: true } }],
  [/GET \S+\/pn-B\?fields=/, { body: { id: "pn-B", display_phone_number: "+962 7 9000 0002", verified_name: "Shop B", platform_type: "NOT_APPLICABLE" } }],
  ["POST https://graph.facebook.com/v21.0/pn-B/register", { body: { success: true } }],
];

function build(seed: Record<string, unknown[]> = {}, handlers: GraphHandler[] = okHandlers()) {
  const prisma = makeFakePrisma(seed as never);
  prisma.raw = prisma;
  const g = fakeGraph(handlers);
  const realtime = { emitToWorkspace: jest.fn() };
  const svc = new EmbeddedSignupService(prisma, new MetaGraphClient(g.fetch), realtime as never);
  return { prisma, g, realtime, svc };
}

const growth = { workspace: [{ id: "ws1", plan: "growth" }, { id: "ws2", plan: "growth" }] };

describe("embedded signup", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv({ ...META_ENV })));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  describe("embedded signup hidden when config missing", () => {
    it("enabled:false with a reason key; missing lists env names only, never a value", () => {
      restore();
      restore = isolateEnv({ META_APP_SECRET_WA: "SUPER-SECRET-VALUE" });
      const cfg = embeddedSignupConfig({ includeMissing: true });
      expect(cfg).toEqual({
        enabled: false,
        graphVersion: "v21.0",
        reason: "channels.embedded_signup_not_configured",
        missing: ["META_APP_ID_WA", "META_WA_CONFIG_ID"],
      });
      expect(JSON.stringify(cfg)).not.toContain("SUPER-SECRET-VALUE");
      // callers without channels.update get the reason but not the env names
      expect(embeddedSignupConfig({ includeMissing: false })).toEqual({
        enabled: false,
        graphVersion: "v21.0",
        reason: "channels.embedded_signup_not_configured",
      });
    });

    it("whitespace-only values count as missing; META_APP_ID / META_APP_SECRET are accepted fallbacks", () => {
      restore();
      restore = isolateEnv({ META_APP_ID: "77", META_APP_SECRET: "fallback-secret", META_WA_CONFIG_ID: "  " });
      expect(embeddedSignupConfig({ includeMissing: true })).toMatchObject({ enabled: false, missing: ["META_WA_CONFIG_ID"] });
      process.env.META_WA_CONFIG_ID = "cfg-1";
      const on = embeddedSignupConfig({ includeMissing: true });
      expect(on).toEqual({ enabled: true, appId: "77", configId: "cfg-1", graphVersion: "v21.0" });
      expect(JSON.stringify(on)).not.toContain("fallback-secret");
    });

    it("enabled config carries appId, configId and the optional solutionId, never the secret", () => {
      process.env.META_WA_SOLUTION_ID = "sol-9";
      const cfg = embeddedSignupConfig({ includeMissing: true });
      expect(cfg).toEqual({ enabled: true, appId: META_ENV.META_APP_ID_WA, configId: META_ENV.META_WA_CONFIG_ID, solutionId: "sol-9", graphVersion: "v21.0" });
      expect(JSON.stringify(cfg)).not.toContain(META_ENV.META_APP_SECRET_WA);
    });

    it("production without TOKEN_ENC_KEY hides it with channels.encryption_unavailable (R5)", () => {
      process.env.NODE_ENV = "production";
      expect(embeddedSignupConfig({ includeMissing: true })).toEqual({
        enabled: false,
        graphVersion: "v21.0",
        reason: "channels.encryption_unavailable",
        missing: ["TOKEN_ENC_KEY"],
      });
    });

    it("POST is refused with 400 channels.embedded_signup_unavailable before any Graph call", async () => {
      restore();
      restore = isolateEnv({});
      const { svc, g, prisma } = build(growth);
      const err = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" }).catch((e) => e);
      expect(err.getStatus()).toBe(400);
      expect(channelErrorKey(err)).toBe("channels.embedded_signup_unavailable");
      expect(err.getResponse()).toMatchObject({ reason: "channels.embedded_signup_not_configured" });
      expect(g.fetch).not.toHaveBeenCalled();
      expect(prisma.db.channel).toHaveLength(0);
    });
  });

  it("embedded signup creates second meta number without touching the first", async () => {
    const { svc, prisma, g, realtime } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] });
    const beforeA = JSON.parse(JSON.stringify(prisma.db.channel[0]));
    const beforeInteg = JSON.parse(JSON.stringify(prisma.db.integration[0]));

    const dto = await svc.signup("ws1", { code: "code-1", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });

    expect(dto).toMatchObject({
      kind: "whatsapp",
      provider: "meta",
      externalId: "pn-B",
      phoneNumber: "+962790000002",
      displayName: "Shop B",
      status: "active",
      statusReason: null,
      isDefault: false,
      config: { wabaId: "waba-B" },
    });
    // A and its Integration are untouched
    expect(prisma.db.channel).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(prisma.db.channel[0]))).toEqual(beforeA);
    expect(JSON.parse(JSON.stringify(prisma.db.integration))).toEqual([beforeInteg]);
    // B is a channel-only row holding its own (encrypted-at-rest) secrets
    const b = prisma.db.channel[1];
    expect(b.integrationId).toBeNull();
    const secrets = JSON.parse(b.secretsEnc);
    expect(secrets.accessToken).toBe(TOKEN);
    expect(secrets.registrationPin).toMatch(/^\d{6}$/);
    // Graph order: exchange, subscribe, phone, register (with the stored pin)
    expect(g.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v21.0/oauth/access_token",
      "POST /v21.0/waba-B/subscribed_apps",
      "GET /v21.0/pn-B",
      "POST /v21.0/pn-B/register",
    ]);
    expect(g.calls[3].body).toEqual({ messaging_product: "whatsapp", pin: secrets.registrationPin });
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "channels.updated", { channelId: b.id });
    // nothing secret in the DTO
    const json = JSON.stringify(dto);
    for (const s of [TOKEN, secrets.registrationPin, "secretsEnc", "integrationId", "accessToken"]) expect(json).not.toContain(s);
  });

  it("FINISH_ONLY_WABA creates pending channel needing a number", async () => {
    const { svc, prisma, g } = build(growth, [
      ["/oauth/access_token", { body: { access_token: TOKEN } }],
      ["POST https://graph.facebook.com/v21.0/waba-L/subscribed_apps", { body: { success: true } }],
    ]);
    const dto = await svc.signup("ws1", { code: "code-L", wabaId: "waba-L", signupEvent: "FINISH_ONLY_WABA" });
    expect(dto).toMatchObject({
      kind: "whatsapp",
      provider: "meta",
      externalId: null,
      status: "pending",
      isDefault: false,
      config: { wabaId: "waba-L", verification: { stage: "needs_number" } },
    });
    expect(JSON.parse(prisma.db.channel[0].secretsEnc)).toEqual({ accessToken: TOKEN });
    expect(g.called("/register")).toHaveLength(0);

    // a second session for the same WABA reuses the pending row (no duplicate, no extra slot)
    g.prepend(["/oauth/access_token", { body: { access_token: "NEWER-TOKEN-xyz" } }]);
    const again = await svc.signup("ws1", { code: "code-L2", wabaId: "waba-L", signupEvent: "FINISH_ONLY_WABA" });
    expect(again.id).toBe(dto.id);
    expect(prisma.db.channel).toHaveLength(1);
    expect(JSON.parse(prisma.db.channel[0].secretsEnc).accessToken).toBe("NEWER-TOKEN-xyz");
  });

  it("FINISH without a phoneNumberId also waits for a number", async () => {
    const { svc } = build(growth);
    const dto = await svc.signup("ws1", { code: "c", wabaId: "waba-B", signupEvent: "FINISH" });
    expect(dto).toMatchObject({ status: "pending", config: { verification: { stage: "needs_number" } } });
  });

  it("a repeated code (sequential or concurrent) exchanges once and returns the same channel", async () => {
    const { svc, prisma, g } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] });
    const input = { code: "same-code", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" as const };
    const [a, b] = await Promise.all([svc.signup("ws1", input), svc.signup("ws1", input)]);
    const c = await svc.signup("ws1", input);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(g.called("/oauth/access_token")).toHaveLength(1);
    expect(prisma.db.channel).toHaveLength(2);
    // the cache is per workspace: another workspace never gets ws1's channel
    const other = await svc.signup("ws2", { ...input, phoneNumberId: undefined, signupEvent: "FINISH_ONLY_WABA" }).catch((e) => e);
    expect(other.id).not.toBe(a.id);
  });

  it("re-running signup for a number this workspace holds refreshes it in place and keeps its PIN", async () => {
    const { svc, prisma, g } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] });
    const first = await svc.signup("ws1", { code: "c1", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    const pin = JSON.parse(prisma.db.channel[1].secretsEnc).registrationPin;
    prisma.db.channel[1].status = "disconnected";
    prisma.db.channel[1].statusReason = "disconnected_by_user";
    g.prepend(["/oauth/access_token", { body: { access_token: "TOKEN-2-abcdefghijk" } }]);
    const second = await svc.signup("ws1", { code: "c2", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ status: "active", statusReason: null });
    expect(prisma.db.channel).toHaveLength(2);
    const secrets = JSON.parse(prisma.db.channel[1].secretsEnc);
    expect(secrets).toEqual({ accessToken: "TOKEN-2-abcdefghijk", registrationPin: pin });
    expect(g.called("/register").at(-1)!.body.pin).toBe(pin);
  });

  it("the first number of a workspace is written as the legacy Integration (main keeps working)", async () => {
    const { svc, prisma } = build(growth);
    const dto = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(prisma.db.integration).toEqual([
      expect.objectContaining({ workspaceId: "ws1", platform: "whatsapp", provider: "meta", pageId: "pn-B", accessToken: TOKEN }),
    ]);
    expect(JSON.parse(prisma.db.integration[0].raw)).toMatchObject({ wabaId: "waba-B" });
    expect(dto).toMatchObject({ externalId: "pn-B", status: "active", isDefault: true });
    expect(prisma.db.channel[0].integrationId).toBe(prisma.db.integration[0].id);
    // the PIN is kept on the channel even though the token lives on the Integration
    expect(JSON.parse(prisma.db.channel[0].secretsEnc).registrationPin).toMatch(/^\d{6}$/);
  });

  it("a number Meta already lists on Cloud API is not registered again (its PIN is not ours)", async () => {
    const { svc, g } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] });
    g.prepend([/GET \S+\/pn-B\?fields=/, { body: { id: "pn-B", display_phone_number: "+962 7 9000 0002", platform_type: "CLOUD_API" } }]);
    const dto = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(dto.status).toBe("active");
    expect(g.called("/register")).toHaveLength(0);
  });

  it("a refused register parks the channel at needs_registration instead of failing the signup", async () => {
    const { svc, prisma } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] });
    const g2 = fakeGraph([["/pn-B/register", graphError(133005, "Two step verification PIN mismatch")], ...okHandlers()]);
    const svc2 = new EmbeddedSignupService(prisma, new MetaGraphClient(g2.fetch), { emitToWorkspace: jest.fn() } as never);
    void svc;
    const dto = await svc2.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(dto).toMatchObject({
      externalId: "pn-B",
      status: "pending",
      statusReason: "meta_register_failed",
      isDefault: false,
      config: { wabaId: "waba-B", verification: { stage: "needs_registration" } },
    });
  });

  it("a refused WABA subscription leaves the number in error for a reconnect", async () => {
    const { svc } = build({ ...growth, integration: [{ ...integA }], channel: [{ ...chanA }] }, [
      ["subscribed_apps", graphError(200, "Permissions error")],
      ...okHandlers(),
    ]);
    const dto = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(dto).toMatchObject({ status: "error", statusReason: "meta_subscribe_failed", isDefault: false });
  });

  it("a refused code exchange is 400 channels.embedded_signup_failed and creates nothing; no secret is logged", async () => {
    const logs: string[] = [];
    for (const m of ["log", "warn", "error", "debug"] as const) {
      jest.spyOn(Logger.prototype, m).mockImplementation(((...x: unknown[]) => void logs.push(x.map(String).join(" "))) as never);
    }
    const { svc, prisma } = build(growth, [["/oauth/access_token", graphError(100, "code expired")]]);
    const err = await svc.signup("ws1", { code: "CODE-SECRET-1", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(channelErrorKey(err)).toBe("channels.embedded_signup_failed");
    expect(err.getResponse()).toMatchObject({ step: "exchange", metaCode: 100 });
    expect(prisma.db.channel).toHaveLength(0);
    const text = logs.join(" ") + JSON.stringify(err.getResponse());
    expect(text).not.toContain("CODE-SECRET-1");
    expect(text).not.toContain(META_ENV.META_APP_SECRET_WA);
  });

  it("the limit is checked first: 409 channels.limit_reached and Meta is never called", async () => {
    const { svc, g } = build({ workspace: [{ id: "ws1", plan: "free" }], integration: [{ ...integA }], channel: [{ ...chanA }] });
    const err = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" }).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ message: "channels.limit_reached", limit: 1, plan: "free" });
    expect(g.fetch).not.toHaveBeenCalled();
  });

  it("a number live in another workspace is 409 channels.connected_elsewhere", async () => {
    const { svc, prisma } = build({
      ...growth,
      integration: [{ ...integA }],
      channel: [{ ...chanA }, { ...chanA, id: "other", workspaceId: "ws2", externalId: "pn-B", integrationId: null, isDefault: true }],
    });
    const err = await svc.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.connected_elsewhere");
    expect(prisma.db.channel.filter((c: { workspaceId: string }) => c.workspaceId === "ws1")).toHaveLength(1);
  });

  it("a missing wabaId is discovered from the token's granular scopes when unambiguous", async () => {
    const { svc, g } = build(growth, [
      ["/debug_token", { body: { data: { is_valid: true, granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["waba-B"] }] } } }],
      ...okHandlers(),
    ]);
    const dto = await svc.signup("ws1", { code: "c", phoneNumberId: "pn-B", signupEvent: "FINISH" });
    expect(dto.config).toMatchObject({ wabaId: "waba-B" });
    const dbg = new URL(g.called("/debug_token")[0].url);
    expect(dbg.searchParams.get("input_token")).toBe(TOKEN);

    g.prepend(["/debug_token", { body: { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["w1", "w2"] }] } } }]);
    const err = await svc.signup("ws1", { code: "c-2", phoneNumberId: "pn-B", signupEvent: "FINISH" }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ message: "channels.embedded_signup_failed", step: "waba" });
  });
});
