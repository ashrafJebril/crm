import { ConflictException, ForbiddenException } from "@nestjs/common";
import { WhatsAppService } from "./whatsapp.service";

/**
 * Tech Provider popup connect (Embedded Signup). Pins: switch-gated, Zernio
 * rows never overwritten, phone registration is best-effort, popup rows carry
 * metaUserId for the deauth/deletion callbacks.
 */

type Row = { id: string; pageId?: string; provider: string; platform: string; workspaceId: string; raw?: string | null; accessToken?: string | null };

function makePrisma(rows: Row[]) {
  return {
    integration: {
      findFirst: jest.fn(async ({ where }: { where: Partial<Row> }) =>
        rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null,
      ),
      findMany: jest.fn(async () => rows),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { ...data, id: "new", provider: "meta" };
        rows.push(row);
        return { ...row, pageId: (data as unknown as { pageId: string }).pageId };
      }),
      update: jest.fn(async ({ data }: { data: Row }) => data),
    },
  };
}

function svc(rows: Row[]) {
  const prisma = makePrisma(rows);
  const s = new WhatsAppService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  return { s, prisma };
}

function mockGraph(handlers: Array<[RegExp, (init: RequestInit) => { status?: number; body: unknown }]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const h = handlers.find(([re]) => re.test(url));
    if (!h) throw new Error(`unexpected fetch ${url}`);
    const { status = 200, body } = h[1](init);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("WhatsAppService.embeddedSignupExchange", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...OLD,
      META_TECH_PROVIDER_ENABLED: "true",
      META_APP_ID: "main-id",
      META_APP_SECRET: "main-secret",
      TOKEN_ENC_KEY: "a".repeat(64),
    };
  });
  afterAll(() => {
    process.env = OLD;
  });

  const okGraph = (registerStatus = 200) => [
    [/oauth\/access_token/, () => ({ body: { access_token: "EAAbusiness" } })],
    [/\/PH1\/register/, () => ({ status: registerStatus, body: registerStatus < 400 ? { success: true } : { error: { message: "already registered" } } })],
    [/\/PH1\?fields=/, () => ({ body: { id: "PH1", display_phone_number: "+962 7 9999", verified_name: "Acme" } })],
    [/\/WABA1\/subscribed_apps/, () => ({ body: { success: true } })],
  ] as Array<[RegExp, (init: RequestInit) => { status?: number; body: unknown }]>;

  it("refuses while the Tech Provider switch is off", async () => {
    delete process.env.META_TECH_PROVIDER_ENABLED;
    const { s } = svc([]);
    await expect(s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses to overwrite a Zernio WhatsApp connection", async () => {
    const { s } = svc([{ id: "z", provider: "zernio", platform: "whatsapp", workspaceId: "ws1" }]);
    mockGraph(okGraph());
    await expect(s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1")).rejects.toBeInstanceOf(ConflictException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("exchanges the code with the main app, registers, subscribes and saves metaUserId", async () => {
    const { s, prisma } = svc([]);
    const calls = mockGraph(okGraph());
    const res = await s.embeddedSignupExchange("ws1", "the-code", "PH1", "WABA1", "U123");

    expect(calls[0].url).toContain("client_id=main-id");
    expect(calls[0].url).toContain("code=the-code");
    const reg = calls.find((c) => c.url.includes("/PH1/register"))!;
    expect(JSON.parse(String(reg.init.body))).toMatchObject({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) });
    expect(calls.some((c) => c.url.includes("/WABA1/subscribed_apps"))).toBe(true);

    const saved = prisma.integration.create.mock.calls[0][0].data as unknown as { raw: string; pageId: string };
    const raw = JSON.parse(saved.raw);
    expect(saved.pageId).toBe("PH1");
    expect(raw).toMatchObject({ wabaId: "WABA1", metaUserId: "U123", connectedVia: "embedded_signup" });
    expect(raw.verifyToken).toBeUndefined();
    expect(raw.registrationPin).toBeTruthy();
    expect(raw.registrationPin).not.toMatch(/^\d{6}$/); // stored encrypted
    expect(res).toMatchObject({ connected: true, phoneRegistered: true });
  });

  it("still connects when the number is already registered", async () => {
    const { s, prisma } = svc([]);
    mockGraph(okGraph(400));
    const res = await s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1");
    expect(res).toMatchObject({ connected: true, phoneRegistered: false });
    const raw = JSON.parse((prisma.integration.create.mock.calls[0][0].data as unknown as { raw: string }).raw);
    expect(raw.registrationPin).toBeNull();
  });
});

describe("WhatsAppService.verifyWebhook", () => {
  const OLD = { ...process.env };
  afterAll(() => {
    process.env = OLD;
  });

  it("accepts the single env verify token", async () => {
    process.env.META_VERIFY_TOKEN = "env-tok";
    const { s } = svc([]);
    await expect(s.verifyWebhook("subscribe", "env-tok", "chal")).resolves.toBe("chal");
  });

  it("still accepts legacy per-row tokens", async () => {
    process.env.META_VERIFY_TOKEN = "env-tok";
    const { s } = svc([{ id: "1", provider: "meta", platform: "whatsapp", workspaceId: "w", raw: JSON.stringify({ verifyToken: "aram-wa-x" }) }]);
    await expect(s.verifyWebhook("subscribe", "aram-wa-x", "chal")).resolves.toBe("chal");
    await expect(s.verifyWebhook("subscribe", "nope", "chal")).rejects.toThrow();
  });
});
