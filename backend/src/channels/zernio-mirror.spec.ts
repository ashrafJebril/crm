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
