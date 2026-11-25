import { ConflictException, ForbiddenException } from "@nestjs/common";
import { WhatsAppService } from "./whatsapp.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { fakeGraph, type GraphHandler } from "../channels/whatsapp/test-graph";
import { ChannelResolver } from "../channels/channel-resolver.service";

/**
 * Tech Provider popup connect (Embedded Signup). Pins: switch-gated, Zernio
 * rows never overwritten, phone registration is best-effort, popup rows carry
 * metaUserId for the deauth/deletion callbacks.
 *
 * SP-19 moved the Cloud API path into EmbeddedSignupService, whose own spec
 * covers the channel rows it writes. What the popup route still owns is pinned
 * here: the switch, the Zernio refusal, the provenance the compliance
 * callbacks match on, and the coexistence flow Meta registers for us.
 */

const realFetch = global.fetch;

const okGraph = (registerStatus = 200): GraphHandler[] => [
  ["/oauth/access_token", { body: { access_token: "EAAbusiness" } }],
  [
    /POST \S+\/PH1\/register/,
    {
      status: registerStatus,
      body: registerStatus < 400 ? { success: true } : { error: { message: "already registered" } },
    },
  ],
  [
    /GET \S+\/PH1\?fields=/,
    {
      body: {
        id: "PH1",
        display_phone_number: "+962 7 9999",
        verified_name: "Acme",
        platform_type: "NOT_APPLICABLE",
      },
    },
  ],
  [/POST \S+\/WABA1\/subscribed_apps/, { body: { success: true } }],
];

function build(seed: Record<string, unknown[]> = {}, handlers: GraphHandler[] = okGraph()) {
  const prisma = makeFakePrisma({ workspace: [{ id: "ws1", plan: "growth" }], ...seed } as never);
  (prisma as unknown as { raw: unknown }).raw = prisma;
  const g = fakeGraph(handlers);
  // MetaGraphClient (built with no injected fetch) and the service own Graph
  // calls both go through global fetch, so one fake answers everything.
  global.fetch = g.fetch as unknown as typeof fetch;
  const realtime = { emitToWorkspace: jest.fn() };
  const pipeline = { onInboundMessage: jest.fn(async () => {}) };
  const s = new WhatsAppService(
    prisma,
    realtime as never,
    {} as never,
    pipeline as never,
    { isConfigured: () => false } as never,
    new ChannelResolver(prisma),
  );
  return { s, prisma, g, realtime, pipeline };
}

/** The raw of the legacy Integration the first connected number becomes. */
function legacyRaw(prisma: ReturnType<typeof makeFakePrisma>) {
  const row = prisma.db.integration.find((r: Record<string, unknown>) => r.platform === "whatsapp");
  return row ? (JSON.parse(String(row.raw ?? "{}")) as Record<string, unknown>) : null;
}

describe("WhatsAppService.embeddedSignupExchange", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...OLD,
      META_TECH_PROVIDER_ENABLED: "true",
      META_APP_ID: "main-id",
      META_APP_SECRET: "main-secret",
      META_WA_CONFIG_ID: "cfg-1",
      TOKEN_ENC_KEY: "a".repeat(64),
    };
  });
  afterEach(() => {
    global.fetch = realFetch;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("refuses while the Tech Provider switch is off", async () => {
    delete process.env.META_TECH_PROVIDER_ENABLED;
    const { s } = build();
    await expect(s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses to overwrite a Zernio WhatsApp connection", async () => {
    const { s, g } = build({
      integration: [{ id: "z", provider: "zernio", platform: "whatsapp", workspaceId: "ws1", pageId: "acc1" }],
    });
    await expect(s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(g.calls).toHaveLength(0);
  });

  it("exchanges the code, registers, subscribes and saves metaUserId", async () => {
    const { s, prisma, g } = build();
    await s.embeddedSignupExchange("ws1", "the-code", "PH1", "WABA1", "U123");

    const exchange = g.calls.find((c) => c.url.includes("/oauth/access_token"))!;
    expect(exchange.url).toContain("code=the-code");
    const reg = g.calls.find((c) => c.url.includes("/PH1/register"))!;
    expect(reg.body).toMatchObject({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) });
    expect(g.calls.some((c) => c.url.includes("/WABA1/subscribed_apps"))).toBe(true);

    // The deauth / data-deletion callbacks match on `raw.metaUserId`.
    expect(legacyRaw(prisma)).toMatchObject({
      wabaId: "WABA1",
      metaUserId: "U123",
      connectedVia: "embedded_signup",
    });
  });

  it("still connects when the number is already registered", async () => {
    const { s, prisma } = build({}, okGraph(400));
    const channel = await s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1");
    // SP-19 T4: a refused register parks the number for the landline card
    // instead of losing the signup.
    expect(channel).toMatchObject({ status: "pending" });
    expect(legacyRaw(prisma)).toMatchObject({ wabaId: "WABA1", connectedVia: "embedded_signup" });
  });

  it("coexistence skips /register and starts the contacts + history sync", async () => {
    const { s, prisma, g } = build({}, [
      ...okGraph(),
      [/POST \S+\/PH1\/smb_app_data/, { body: { success: true } }],
    ]);
    const res = await s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1", "U1", "coexistence");

    expect(g.calls.some((c) => c.url.includes("/PH1/register"))).toBe(false);
    const syncs = g.calls
      .filter((c) => c.url.includes("/PH1/smb_app_data"))
      .map((c) => (c.body as { sync_type: string }).sync_type);
    expect(syncs).toEqual(["smb_app_state_sync", "history"]);
    expect(legacyRaw(prisma)).toMatchObject({ connectedVia: "coexistence", metaUserId: "U1" });
    expect(res).toMatchObject({
      connected: true,
      coexistence: true,
      syncStarted: { contacts: true, history: true },
    });
  });

  it("coexistence still connects when the sync call fails", async () => {
    const { s } = build({}, [
      ...okGraph(),
      [/smb_app_data/, { status: 400, body: { error: { message: "window closed" } } }],
    ]);
    const res = await s.embeddedSignupExchange("ws1", "code", "PH1", "WABA1", undefined, "coexistence");
    expect(res).toMatchObject({ connected: true, syncStarted: { contacts: false, history: false } });
  });
});

describe("WhatsAppService.verifyWebhook", () => {
  const OLD = { ...process.env };
  afterEach(() => {
    global.fetch = realFetch;
  });
  afterAll(() => {
    process.env = OLD;
  });

  it("accepts the single env verify token", async () => {
    process.env.META_VERIFY_TOKEN = "env-tok";
    const { s } = build();
    await expect(s.verifyWebhook("subscribe", "env-tok", "chal")).resolves.toBe("chal");
  });

  it("still accepts legacy per-row tokens", async () => {
    process.env.META_VERIFY_TOKEN = "env-tok";
    const { s } = build({
      integration: [
        {
          id: "1",
          provider: "meta",
          platform: "whatsapp",
          workspaceId: "w",
          raw: JSON.stringify({ verifyToken: "aram-wa-x" }),
        },
      ],
    });
    await expect(s.verifyWebhook("subscribe", "aram-wa-x", "chal")).resolves.toBe("chal");
    await expect(s.verifyWebhook("subscribe", "nope", "chal")).rejects.toThrow();
  });
});

describe("WhatsAppService coexistence webhooks", () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** A connected Meta number, so the webhook resolves to its channel. */
  const connected = {
    integration: [
      {
        id: "i1",
        workspaceId: "ws1",
        platform: "whatsapp",
        provider: "meta",
        pageId: "PH1",
        pageName: "+962 7 9999",
        accessToken: "TOKEN",
        raw: JSON.stringify({ wabaId: "WABA1", verifyToken: "v" }),
      },
    ],
    channel: [
      {
        id: "ch1",
        workspaceId: "ws1",
        kind: "whatsapp",
        provider: "meta",
        externalId: "PH1",
        displayName: "+962 7 9999",
        status: "active",
        isDefault: true,
        integrationId: "i1",
        config: { wabaId: "WABA1" },
      },
    ],
  };

  const hook = (value: object) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA1", changes: [{ field: "x", value: { metadata: { phone_number_id: "PH1" }, ...value } }] }],
  });

  it("stores phone-sent echoes as our messages, once, without unread or pipeline", async () => {
    const { s, prisma, pipeline } = build(connected as never);
    const echo = {
      from: "962700",
      to: "962799",
      id: "wamid.E1",
      timestamp: "1700000000",
      type: "text",
      text: { body: "hi from phone" },
    };
    await s.handleWebhook(hook({ message_echoes: [echo] }) as never);
    await s.handleWebhook(hook({ message_echoes: [echo] }) as never);

    expect(prisma.db.message).toEqual([
      expect.objectContaining({ from: "human", body: "hi from phone", metaMessageId: "wamid.E1" }),
    ]);
    expect(pipeline.onInboundMessage).not.toHaveBeenCalled();
    expect(prisma.db.conversation[0]?.unreadCount ?? 0).toBe(0);
    // SP-19: the thread belongs to the number it arrived on, so a reply goes
    // back out through it instead of the workspace default.
    expect(prisma.db.conversation[0]?.channelId).toBe("ch1");
  });

  it("imports history with the right side for each message", async () => {
    const { s, prisma } = build(connected as never);
    await s.handleWebhook(
      hook({
        history: [
          {
            threads: [
              {
                id: "962700",
                messages: [
                  { from: "962700", id: "wamid.H1", timestamp: "1700000000", type: "text", text: { body: "question" } },
                  { from: "962799", id: "wamid.H2", timestamp: "1700000100", type: "text", text: { body: "answer" } },
                ],
              },
            ],
          },
        ],
      }) as never,
    );
    expect(prisma.db.message.map((m: Record<string, unknown>) => [m.from, m.body])).toEqual([
      ["them", "question"],
      ["human", "answer"],
    ]);
  });
});
