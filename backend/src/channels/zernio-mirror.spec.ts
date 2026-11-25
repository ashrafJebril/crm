import { mirrorZernioAccounts, ZERNIO_MISSING } from "./zernio-mirror";
import { ZernioService } from "../integrations/zernio.service";
import { makeFakePrisma } from "./test-prisma";

const acc = (id: string, platform = "whatsapp", over: Record<string, unknown> = {}) => ({
  _id: id,
  platform,
  displayName: `Name ${id}`,
  ...over,
});

describe("zernio sync mirrors every account and disconnects missing ones", () => {
  it("one channel per account (not one per platform), legacy row relinked to the primary", async () => {
    const prisma = makeFakePrisma({
      workspace: [{ id: "ws1", zernioProfileId: "prof1" }],
      channel: [
        {
          id: "gone",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "zernio",
          externalId: "acc-old",
          displayName: "Old",
          status: "active",
          isDefault: true,
          integrationId: null,
          createdAt: new Date("2025-01-01"),
          updatedAt: new Date("2025-01-01"),
        },
      ],
    });
    const client = {
      listAccounts: jest.fn(async () => [
        acc("acc-A"),
        acc("acc-B", "whatsapp", { needsReconnection: true }),
        acc("acc-FB", "facebook"),
      ]),
      isConfigured: () => true,
    };
    const realtime = { emitToWorkspace: jest.fn() };
    const svc = new ZernioService(
      prisma,
      realtime as never,
      {} as never,
      client as never,
      {} as never,
      { enabled: false } as never,
      {} as never,
    );
    await svc.syncAccounts("ws1");

    const byExt = Object.fromEntries(prisma.db.channel.map((c: { externalId: string }) => [c.externalId, c]));
    expect(Object.keys(byExt).sort()).toEqual(["acc-A", "acc-B", "acc-FB", "acc-old"]);
    expect(byExt["acc-A"]).toMatchObject({ kind: "whatsapp", provider: "zernio", status: "active", displayName: "Name acc-A" });
    expect(byExt["acc-B"]).toMatchObject({ status: "needs_attention" });
    expect(byExt["acc-B"].statusReason).toBeTruthy();
    expect(byExt["acc-old"]).toMatchObject({ status: "disconnected", statusReason: ZERNIO_MISSING, isDefault: false });
    expect(byExt["acc-old"].disconnectedAt).toBeInstanceOf(Date);

    // the single Integration row per platform is kept for main, linked to its primary's channel
    const waInteg = prisma.db.integration.find((i: { platform: string }) => i.platform === "whatsapp");
    expect(waInteg.pageId).toBe("acc-A");
    expect(byExt["acc-A"].integrationId).toBe(waInteg.id);
    // one default per kind, active only
    expect(byExt["acc-A"].isDefault).toBe(true);
    expect(byExt["acc-B"].isDefault).toBe(false);
    expect(byExt["acc-FB"].isDefault).toBe(true);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "channels.updated", {});

    // rerun: no new rows, a returning account reactivates
    client.listAccounts.mockResolvedValueOnce([acc("acc-A"), acc("acc-B"), acc("acc-FB", "facebook"), acc("acc-old")]);
    await svc.syncAccounts("ws1");
    expect(prisma.db.channel).toHaveLength(4);
    const old = prisma.db.channel.find((c: { externalId: string }) => c.externalId === "acc-old");
    expect(old).toMatchObject({ status: "active", disconnectedAt: null, statusReason: null });
  });

  it("does not resurrect a channel the user disconnected", async () => {
    const prisma = makeFakePrisma({
      channel: [
        {
          id: "u",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "zernio",
          externalId: "acc-U",
          displayName: "U",
          status: "disconnected",
          statusReason: "disconnected_by_user",
          isDefault: false,
          integrationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-U")], []);
    expect(prisma.db.channel[0].status).toBe("disconnected");
  });

  /**
   * Reported from production 2026-11-25: a user disconnected Facebook in the
   * hub, reconnected it through "Add channel", got a "Facebook connected"
   * toast — and the channel stayed under Disconnected. Zernio listed the
   * account as active the whole time (same account id, needsReconnection
   * false), so only our mirror was holding it down: a sync refuses to revive
   * `disconnected_by_user`, and the OAuth landing went through that same
   * generic sync with no way to say "the user just authorised this".
   */
  const userDisconnectedFb = () => ({
    channel: [
      {
        id: "fb",
        workspaceId: "ws1",
        kind: "facebook",
        provider: "zernio",
        externalId: "acc-FB",
        displayName: "FB",
        status: "disconnected",
        statusReason: "disconnected_by_user",
        isDefault: false,
        integrationId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  });

  it("revives a user-disconnected channel when its platform was just authorised", async () => {
    const prisma = makeFakePrisma(userDisconnectedFb());
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-FB", "facebook")], [], {
      explicitPlatform: "facebook",
    });
    expect(prisma.db.channel[0]).toMatchObject({ status: "active", statusReason: null });
  });

  it("revives only the platform that was authorised", async () => {
    // Connecting Facebook must not quietly undo a WhatsApp disconnect.
    const base = userDisconnectedFb();
    base.channel.push({
      ...base.channel[0],
      id: "wa",
      kind: "whatsapp",
      externalId: "acc-WA",
      displayName: "WA",
    });
    const prisma = makeFakePrisma(base);
    await mirrorZernioAccounts(
      prisma,
      "ws1",
      [acc("acc-FB", "facebook"), acc("acc-WA", "whatsapp")],
      [],
      { explicitPlatform: "facebook" },
    );
    const byId = Object.fromEntries(prisma.db.channel.map((c: { id: string }) => [c.id, c]));
    expect(byId.fb).toMatchObject({ status: "active" });
    expect(byId.wa).toMatchObject({ status: "disconnected", statusReason: "disconnected_by_user" });
  });

  it("still refuses to revive on a routine sync", async () => {
    // R9 unchanged: a background reconcile must never undo a hub disconnect.
    const prisma = makeFakePrisma(userDisconnectedFb());
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-FB", "facebook")], []);
    expect(prisma.db.channel[0]).toMatchObject({ status: "disconnected" });
  });

  it("never touches another workspace's channels", async () => {
    const prisma = makeFakePrisma({
      channel: [
        {
          id: "other",
          workspaceId: "ws2",
          kind: "whatsapp",
          provider: "zernio",
          externalId: "acc-X",
          displayName: "X",
          status: "active",
          isDefault: true,
          integrationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    await mirrorZernioAccounts(prisma, "ws1", [], []);
    expect(prisma.db.channel[0].status).toBe("active");
  });
});

describe("zernio sync keeps the user's channel name and fills the phone (SP-19 I1)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    workspaceId: "ws1",
    kind: "whatsapp",
    provider: "zernio",
    externalId: "acc-A",
    displayName: "Shop",
    status: "active",
    isDefault: true,
    integrationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it("a new channel records Zernio's name as config.providerName", async () => {
    const prisma = makeFakePrisma({ channel: [] });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop" })], []);
    expect(prisma.db.channel[0]).toMatchObject({ displayName: "Shop", config: { providerName: "Shop" } });
  });

  it("a rename in the hub survives every sync", async () => {
    const prisma = makeFakePrisma({ channel: [] });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop" })], []);
    prisma.db.channel[0].displayName = "Shop sales"; // hub rename
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop" })], []);
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop Ltd" })], []);
    expect(prisma.db.channel[0].displayName).toBe("Shop sales");
    expect(prisma.db.channel[0].config).toMatchObject({ providerName: "Shop Ltd" });
  });

  it("an unrenamed channel follows Zernio's new name", async () => {
    const prisma = makeFakePrisma({ channel: [row({ config: { providerName: "Shop" } })] });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop Ltd" })], []);
    expect(prisma.db.channel[0]).toMatchObject({ displayName: "Shop Ltd", config: { providerName: "Shop Ltd" } });
  });

  it("a row with no recorded provider name keeps its name and starts tracking Zernio's", async () => {
    const prisma = makeFakePrisma({ channel: [row({ displayName: "Support line", config: { other: 1 } })] });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A", "whatsapp", { displayName: "Shop" })], []);
    expect(prisma.db.channel[0].displayName).toBe("Support line");
    expect(prisma.db.channel[0].config).toEqual({ other: 1, providerName: "Shop" });
  });

  it("fills phoneNumber from the WhatsApp account metadata (create and update)", async () => {
    const prisma = makeFakePrisma({ channel: [row()] });
    await mirrorZernioAccounts(
      prisma,
      "ws1",
      [
        acc("acc-A", "whatsapp", { metadata: { displayPhoneNumber: "+971 50 123 4567" } }),
        acc("acc-B", "whatsapp", { metadata: { phoneNumber: "966501112222" } }),
        acc("acc-C", "whatsapp"),
        acc("acc-IG", "instagram", { username: "shop", metadata: { phoneNumber: "966500000000" } }),
      ],
      [],
    );
    const byExt = Object.fromEntries(prisma.db.channel.map((c: { externalId: string }) => [c.externalId, c]));
    expect(byExt["acc-A"].phoneNumber).toBe("+971501234567");
    expect(byExt["acc-B"].phoneNumber).toBe("+966501112222");
    expect(byExt["acc-C"].phoneNumber ?? null).toBeNull();
    expect(byExt["acc-IG"].phoneNumber ?? null).toBeNull();
  });

  it("keeps a known phoneNumber when the metadata omits it", async () => {
    const prisma = makeFakePrisma({ channel: [row({ phoneNumber: "+971501234567" })] });
    await mirrorZernioAccounts(prisma, "ws1", [acc("acc-A")], []);
    expect(prisma.db.channel[0].phoneNumber).toBe("+971501234567");
  });
});
