import { WhatsAppService } from "../../integrations/whatsapp.service";
import { ZernioService } from "../../integrations/zernio.service";
import { makeFakePrisma } from "../test-prisma";
import { channelErrorKey } from "../channel-errors";
import { MetaGraphClient } from "./meta-graph.client";
import { EmbeddedSignupService } from "./embedded-signup.service";
import { fakeGraph, isolateEnv, META_ENV } from "./test-graph";

/**
 * SP-19 T4: several Meta numbers per workspace (ruling 4: a manual connect of
 * another number adds a channel instead of overwriting the first), the plan
 * limit on every add flow, and number-B isolation for a second Meta number.
 */

const WA = "962790000001";
const TOKEN_B = "TOKEN-B-0123456789abcdef";

const integA = (over: Record<string, unknown> = {}) => ({
  id: "I-A",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "meta",
  pageId: "pn-A",
  pageName: "+962 7 9000 0001",
  accessToken: "TOKEN-A",
  raw: JSON.stringify({ wabaId: "waba-A", verifyToken: "v-A" }),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});
const chanA = (over: Record<string, unknown> = {}) => ({
  id: "chi_I-A",
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "meta",
  externalId: "pn-A",
  displayName: "+962 7 9000 0001",
  status: "active",
  isDefault: true,
  integrationId: "I-A",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

function seed(plan = "growth", over: { integration?: unknown[]; channel?: unknown[] } = {}) {
  const prisma = makeFakePrisma({
    workspace: [{ id: "ws1", plan, zernioProfileId: "prof" }],
    integration: over.integration ?? [integA()],
    channel: over.channel ?? [chanA()],
  } as never);
  prisma.raw = prisma;
  return prisma;
}

type FetchJson = (url: string, init: RequestInit) => Promise<unknown>;

/** WhatsAppService with its Graph calls (`fetchJson`) answered by `routes`. */
function meta(prisma: ReturnType<typeof makeFakePrisma>, routes: Array<[string, unknown]> = []) {
  const svc = new WhatsAppService(
    prisma,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    { onInboundMessage: jest.fn(async () => {}) } as never,
    { isConfigured: () => false } as never,
  );
  const fetchJson = jest
    .spyOn(svc as unknown as { fetchJson: FetchJson }, "fetchJson")
    .mockImplementation(async (url: string) => {
      for (const [pat, body] of routes) if (url.includes(pat)) return body;
      if (url.endsWith("/subscribed_apps")) return { success: true };
      if (url.endsWith("/messages")) return { messages: [{ id: "wamid.out" }] };
      throw new Error(`unmocked Graph call ${url}`);
    });
  return { svc, fetchJson };
}

const phoneB: [string, unknown] = ["/pn-B?fields=", { id: "pn-B", display_phone_number: "+962 7 9000 0002", verified_name: "Shop B" }];
const phoneA: [string, unknown] = ["/pn-A?fields=", { id: "pn-A", display_phone_number: "+962 7 9000 0001", verified_name: "Shop A" }];

const metaEvent = (phoneNumberId: string, wamid: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba",
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: WA, profile: { name: "Sara" } }],
            messages: [{ from: WA, id: wamid, timestamp: "1700000000", type: "text", text: { body: `hi ${phoneNumberId}` } }],
          },
        },
      ],
    },
  ],
});

describe("manual connect of a different number adds a channel", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv()));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("connect with another phone number id keeps number A and its Integration, and adds B as its own channel", async () => {
    const prisma = seed();
    const beforeInteg = JSON.parse(JSON.stringify(prisma.db.integration));
    const { svc } = meta(prisma, [phoneB]);

    const res = await svc.connect("ws1", { phoneNumberId: "pn-B", wabaId: "waba-B", accessToken: TOKEN_B, verifyToken: "v-B" });

    expect(JSON.parse(JSON.stringify(prisma.db.integration))).toEqual(beforeInteg); // A not overwritten
    expect(prisma.db.channel).toHaveLength(2);
    expect(prisma.db.channel[0]).toMatchObject({ id: "chi_I-A", externalId: "pn-A", status: "active", isDefault: true });
    const b = prisma.db.channel[1];
    expect(b).toMatchObject({
      kind: "whatsapp",
      provider: "meta",
      externalId: "pn-B",
      phoneNumber: "+962790000002",
      status: "active",
      isDefault: false,
      integrationId: null,
      config: { wabaId: "waba-B" },
    });
    expect(JSON.parse(b.secretsEnc)).toEqual({ accessToken: TOKEN_B });
    expect(res).toMatchObject({ connected: true, phoneNumberId: "pn-B", channelId: b.id, webhookSubscribed: true });
    // a channel-only number has no Integration verify token to hand out
    expect(res).not.toHaveProperty("verifyToken");
  });

  const twoNumbers = (): Array<[string, unknown]> => [
    ["/me?fields=id,name", { id: "user-1" }],
    ["/me/businesses", { data: [{ id: "biz", owned_whatsapp_business_accounts: { data: [{ id: "waba-A" }] } }] }],
    ["/waba-A?fields=id,name", { id: "waba-A", name: "Shop" }],
    // Meta's test number listed first, next to the workspace's real number
    ["/waba-A/phone_numbers", { data: [{ id: "pn-B", display_phone_number: "+962 7 9000 0002" }, { id: "pn-A", display_phone_number: "+962 7 9000 0001" }] }],
    phoneA,
    phoneB,
  ];

  it("a token refresh with two WABA numbers refreshes the held one and adds nothing (I1)", async () => {
    const prisma = seed("free");
    prisma.db.channel[0].status = "needs_attention";
    const { svc } = meta(prisma, twoNumbers());
    const res = await svc.connectByToken("ws1", TOKEN_B);
    expect(res.discovered.picked).toEqual({ wabaId: "waba-A", phoneNumberId: "pn-A" });
    expect(prisma.db.channel.map((c: { externalId: string }) => c.externalId)).toEqual(["pn-A"]);
    expect(prisma.db.integration).toHaveLength(1);
    expect(prisma.db.integration[0]).toMatchObject({ pageId: "pn-A", accessToken: TOKEN_B });
    expect(prisma.db.channel[0]).toMatchObject({ status: "active", statusReason: null });
  });

  it("a held number that was disconnected is refreshed and reactivated, not replaced", async () => {
    const prisma = seed("growth", { channel: [chanA({ status: "disconnected", statusReason: "disconnected_by_user", isDefault: false })] });
    const { svc } = meta(prisma, twoNumbers());
    await svc.connectByToken("ws1", TOKEN_B);
    expect(prisma.db.channel).toHaveLength(1);
    expect(prisma.db.channel[0]).toMatchObject({ externalId: "pn-A", status: "active", statusReason: null });
    expect(prisma.db.integration[0].accessToken).toBe(TOKEN_B);
  });

  it("an explicit add (the hub's manual route) takes the token's number this workspace does not have yet", async () => {
    const prisma = seed();
    const { svc } = meta(prisma, twoNumbers());
    const res = await svc.connectByToken("ws1", TOKEN_B, { add: true, errorStyle: "keys" });
    expect(res.discovered.picked).toEqual({ wabaId: "waba-A", phoneNumberId: "pn-B" });
    expect(prisma.db.channel.map((c: { externalId: string }) => c.externalId)).toEqual(["pn-A", "pn-B"]);
    expect(prisma.db.integration[0]).toMatchObject({ pageId: "pn-A", accessToken: "TOKEN-A" });
  });

  it("without an add intent, a token that cannot reach any held number adds nothing", async () => {
    const prisma = seed();
    const { svc } = meta(prisma, [
      ["/me?fields=id,name", { id: "user-1" }],
      ["/me/businesses", { data: [{ id: "biz", owned_whatsapp_business_accounts: { data: [{ id: "waba-X" }] } }] }],
      ["/waba-X?fields=id,name", { id: "waba-X" }],
      ["/waba-X/phone_numbers", { data: [{ id: "pn-X" }] }],
    ]);
    const keyed = await svc.connectByToken("ws1", TOKEN_B, { errorStyle: "keys" }).catch((e) => e);
    expect(channelErrorKey(keyed)).toBe("channels.meta_no_number");
    const legacy = await svc.connectByToken("ws1", TOKEN_B).catch((e) => e);
    expect(legacy.getStatus()).toBe(400);
    expect(prisma.db.channel).toHaveLength(1);
  });

  it("a workspace with no Meta number still connects the token's first number", async () => {
    const prisma = seed("growth", { integration: [], channel: [] });
    const { svc } = meta(prisma, twoNumbers());
    const res = await svc.connectByToken("ws1", TOKEN_B);
    expect(res.discovered.picked.phoneNumberId).toBe("pn-B");
    expect(prisma.db.integration[0]).toMatchObject({ pageId: "pn-B", accessToken: TOKEN_B });
  });

  it("connect-by-token honours an explicit phoneNumberId and refuses one the token does not hold (keys mode)", async () => {
    const prisma = seed();
    const routes: Array<[string, unknown]> = [
      ["/me?fields=id,name", { id: "user-1" }],
      ["/me/businesses", { data: [{ id: "biz", owned_whatsapp_business_accounts: { data: [{ id: "waba-A" }] } }] }],
      ["/waba-A?fields=id,name", { id: "waba-A" }],
      ["/waba-A/phone_numbers", { data: [{ id: "pn-A" }, { id: "pn-B" }] }],
      phoneA,
    ];
    const { svc } = meta(prisma, routes);
    const res = await svc.connectByToken("ws1", TOKEN_B, { phoneNumberId: "pn-A", errorStyle: "keys" });
    expect(res.discovered.picked.phoneNumberId).toBe("pn-A");
    const err = await svc.connectByToken("ws1", TOKEN_B, { phoneNumberId: "pn-Z", errorStyle: "keys" }).catch((e) => e);
    expect(channelErrorKey(err)).toBe("channels.meta_no_number");
  });

  it("keys mode maps a rejected token to channels.meta_token_invalid; legacy mode keeps the English message", async () => {
    const prisma = seed();
    const { svc, fetchJson } = meta(prisma);
    fetchJson.mockRejectedValue(new Error("Invalid OAuth access token"));
    const keyed = await svc.connectByToken("ws1", "x".repeat(30), { errorStyle: "keys" }).catch((e) => e);
    expect(channelErrorKey(keyed)).toBe("channels.meta_token_invalid");
    const legacy = await svc.connectByToken("ws1", "x".repeat(30)).catch((e) => e);
    expect(String(legacy.message)).toMatch(/Token rejected by Meta/);
  });

  it("connecting the same number again still refreshes the legacy Integration in place", async () => {
    const prisma = seed();
    const { svc } = meta(prisma, [phoneA]);
    const res = await svc.connect("ws1", { phoneNumberId: "pn-A", wabaId: "waba-A", accessToken: "TOKEN-A2-xxxxxxxxxxxx", verifyToken: "v2" });
    expect(prisma.db.integration).toHaveLength(1);
    expect(prisma.db.integration[0]).toMatchObject({ pageId: "pn-A", accessToken: "TOKEN-A2-xxxxxxxxxxxx" });
    expect(prisma.db.channel).toHaveLength(1);
    expect(res).toMatchObject({ channelId: "chi_I-A", verifyToken: "v2" });
  });

  it("a Meta number next to a Zernio WhatsApp Integration becomes its own channel (the Zernio row is untouched)", async () => {
    const prisma = seed("growth", {
      integration: [integA({ provider: "zernio", pageId: "acc-Z", accessToken: null, raw: null })],
      channel: [chanA({ provider: "zernio", externalId: "acc-Z" })],
    });
    const { svc } = meta(prisma, [phoneB]);
    await svc.connect("ws1", { phoneNumberId: "pn-B", wabaId: "waba-B", accessToken: TOKEN_B, verifyToken: "v" });
    expect(prisma.db.integration[0]).toMatchObject({ provider: "zernio", pageId: "acc-Z" });
    expect(prisma.db.channel.map((c: { provider: string; externalId: string }) => `${c.provider}:${c.externalId}`)).toEqual(["zernio:acc-Z", "meta:pn-B"]);
  });
});

describe("number limit blocks add flows but not zernio mirror", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv({ ...META_ENV })));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  function zernio(prisma: ReturnType<typeof makeFakePrisma>, accounts: unknown[] = []) {
    const client = {
      isConfigured: () => true,
      listAccounts: jest.fn(async () => accounts),
      getConnectUrl: jest.fn(async () => ({ authUrl: "https://zernio.example/connect" })),
    };
    const svc = new ZernioService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      client as never,
      { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
      { enabled: false } as never,
      { isConfigured: () => false } as never,
    );
    return { svc, client };
  }

  it("reconnecting the held Zernio WhatsApp number is not gated by the limit (C1)", async () => {
    for (const state of [
      { status: "needs_attention", statusReason: null },
      { status: "disconnected", statusReason: "zernio_account_missing" },
      { status: "disconnected", statusReason: "integration_removed" },
    ]) {
      const prisma = seed("free", {
        integration: [integA({ provider: "zernio", pageId: "acc-A", accessToken: null, raw: null })],
        channel: [chanA({ provider: "zernio", externalId: "acc-A", ...state })],
      });
      // a second, healthy number fills the free slot when the first is disconnected
      if (state.status === "disconnected") {
        prisma.db.channel.push(chanA({ id: "other", integrationId: null, externalId: "pn-Z", isDefault: false }));
      }
      const { svc, client } = zernio(prisma);
      await expect(svc.getConnectUrl("ws1", "whatsapp")).resolves.toEqual({ authUrl: "https://zernio.example/connect" });
      expect(client.getConnectUrl).toHaveBeenCalledTimes(1);
    }
  });

  it("a user-disconnected Zernio number is not a reconnect: the link stays gated", async () => {
    const prisma = seed("free", {
      integration: [integA({ provider: "zernio", pageId: "acc-A", accessToken: null, raw: null })],
      channel: [
        chanA({ provider: "zernio", externalId: "acc-A", status: "disconnected", statusReason: "disconnected_by_user", isDefault: false }),
        chanA({ id: "live", integrationId: null, externalId: "pn-Z" }),
      ],
    });
    const { svc } = zernio(prisma);
    const e = await svc.getConnectUrl("ws1", "whatsapp").catch((x: unknown) => x);
    expect(channelErrorKey(e)).toBe("channels.limit_reached");
  });

  it("free plan with one number: embedded signup, manual connect and the Zernio WhatsApp link are 409; Meta/Zernio never called", async () => {
    const prisma = seed("free");
    const g = fakeGraph();
    const signup = new EmbeddedSignupService(prisma, new MetaGraphClient(g.fetch), { emitToWorkspace: jest.fn() } as never);
    const limited = async (p: Promise<unknown>) => {
      const e = (await p.catch((x: unknown) => x)) as { getStatus(): number; getResponse(): unknown };
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ message: "channels.limit_reached", limit: 1, plan: "free" });
    };

    await limited(signup.signup("ws1", { code: "c", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" }));
    await limited(signup.signup("ws1", { code: "c2", wabaId: "waba-L", signupEvent: "FINISH_ONLY_WABA" }));
    expect(g.fetch).not.toHaveBeenCalled();

    const { svc: wa, fetchJson } = meta(prisma, [phoneB]);
    await limited(wa.connect("ws1", { phoneNumberId: "pn-B", wabaId: "waba-B", accessToken: TOKEN_B, verifyToken: "v" }));
    expect(fetchJson).not.toHaveBeenCalled();

    const { svc: z, client } = zernio(prisma);
    await limited(z.getConnectUrl("ws1", "whatsapp"));
    expect(client.getConnectUrl).not.toHaveBeenCalled();
    // other platforms are not limited
    await expect(z.getConnectUrl("ws1", "instagram")).resolves.toEqual({ authUrl: "https://zernio.example/connect" });

    expect(prisma.db.channel).toHaveLength(1);
  });

  it("the env override raises the limit for every plan", async () => {
    process.env.CHANNEL_WHATSAPP_LIMIT = "2";
    const prisma = seed("free");
    const { svc } = meta(prisma, [phoneB]);
    await svc.connect("ws1", { phoneNumberId: "pn-B", wabaId: "waba-B", accessToken: TOKEN_B, verifyToken: "v" });
    expect(prisma.db.channel).toHaveLength(2);
  });

  it("re-connecting a number the workspace already holds needs no free slot", async () => {
    const prisma = seed("free");
    const { svc } = meta(prisma, [phoneA]);
    await expect(svc.connect("ws1", { phoneNumberId: "pn-A", wabaId: "waba-A", accessToken: "TOKEN-A2-xxxxxxxxxxxx", verifyToken: "v" })).resolves.toMatchObject({ connected: true });
  });

  it("a legacy Integration not mirrored yet still counts toward the limit", async () => {
    const prisma = seed("free", { channel: [] });
    const { svc } = meta(prisma, [phoneB]);
    const e = await svc.connect("ws1", { phoneNumberId: "pn-B", wabaId: "waba-B", accessToken: TOKEN_B, verifyToken: "v" }).catch((x) => x);
    expect(channelErrorKey(e)).toBe("channels.limit_reached");
  });

  it("a Zernio sync mirrors every listed number even beyond the limit; inbound is never dropped", async () => {
    const prisma = seed("free", {
      integration: [integA({ provider: "zernio", pageId: "acc-A", accessToken: null, raw: null })],
      channel: [chanA({ provider: "zernio", externalId: "acc-A" })],
    });
    const { svc } = zernio(prisma, [
      { _id: "acc-A", platform: "whatsapp", displayName: "A" },
      { _id: "acc-B", platform: "whatsapp", displayName: "B" },
      { _id: "acc-C", platform: "whatsapp", displayName: "C" },
    ]);
    await svc.syncAccounts("ws1");
    const live = prisma.db.channel.filter((c: { status: string }) => c.status !== "disconnected");
    expect(live.map((c: { externalId: string }) => c.externalId).sort()).toEqual(["acc-A", "acc-B", "acc-C"]);
  });
});

describe("a second Meta number's inbound and replies stay on that number", () => {
  let restore: () => void;
  beforeEach(() => (restore = isolateEnv({ ...META_ENV })));
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
  });

  it("number B from embedded signup: inbound lands in B's conversation, replies go out from B with B's token", async () => {
    const prisma = seed("growth");
    prisma.db.contact = [];
    prisma.db.conversation = [];
    const g = fakeGraph([
      ["/oauth/access_token", { body: { access_token: TOKEN_B } }],
      ["/waba-B/subscribed_apps", { body: { success: true } }],
      [/GET \S+\/pn-B\?fields=/, { body: { id: "pn-B", display_phone_number: "+962 7 9000 0002", verified_name: "Shop B" } }],
      ["/pn-B/register", { body: { success: true } }],
    ]);
    const signup = new EmbeddedSignupService(prisma, new MetaGraphClient(g.fetch), { emitToWorkspace: jest.fn() } as never);
    const b = await signup.signup("ws1", { code: "code-B", wabaId: "waba-B", phoneNumberId: "pn-B", signupEvent: "FINISH" });

    const { svc, fetchJson } = meta(prisma);
    await svc.handleWebhook(metaEvent("pn-B", "wamid.b1"));
    await svc.handleWebhook(metaEvent("pn-A", "wamid.a1"));
    await svc.handleWebhook(metaEvent("pn-B", "wamid.b2"));

    expect(prisma.db.contact).toHaveLength(1); // one contact, two numbers
    expect(prisma.db.conversation).toHaveLength(2);
    const cvB = prisma.db.conversation.find((c: { channelId: string }) => c.channelId === b.id);
    const cvA = prisma.db.conversation.find((c: { channelId: string }) => c.channelId === "chi_I-A");
    expect(cvB).toBeDefined();
    expect(cvA).toBeDefined();
    const bodies = (cv: { id: string }) =>
      prisma.db.message.filter((m: { conversationId: string }) => m.conversationId === cv.id).map((m: { body: string }) => m.body);
    expect(bodies(cvB)).toEqual(["hi pn-B", "hi pn-B"]);
    expect(bodies(cvA)).toEqual(["hi pn-A"]);

    await svc.sendInConversation("ws1", cvB.id, "reply from B");
    let [url, init] = fetchJson.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-B/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN_B}`);

    await svc.sendInConversation("ws1", cvA.id, "reply from A");
    [url, init] = fetchJson.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/pn-A/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN-A");
  });
});
