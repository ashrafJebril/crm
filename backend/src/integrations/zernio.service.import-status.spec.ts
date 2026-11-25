import { AiBridgeService } from "./ai-bridge.service";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

describe("ZernioService.importStatus", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: { isConfigured: jest.Mock; listAccounts: jest.Mock; getSyncInfo: jest.Mock };
  let svc: ZernioService;

  beforeEach(() => {
    prisma = { workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) } };
    client = {
      isConfigured: jest.fn().mockReturnValue(true),
      listAccounts: jest.fn(),
      getSyncInfo: jest.fn(),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
      { ask: jest.fn().mockResolvedValue(null) } as never,
      { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
    );
  });

  it("reports a fresh Facebook account as importing and an old Instagram one as done", async () => {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    client.listAccounts.mockResolvedValue([
      { _id: "fb", platform: "facebook", isActive: true, createdAt: thirtyMinAgo },
      { _id: "ig", platform: "instagram", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    client.getSyncInfo.mockImplementation(async (_p: string, platform: string) =>
      platform === "facebook"
        ? { total: 0, lastSync: null, syncTriggered: true }
        : { total: 6, lastSync: "2026-11-25T12:00:00.000Z", syncTriggered: false },
    );

    const res = await svc.importStatus("ws1");

    expect(client.listAccounts).toHaveBeenCalledWith("prof1");
    expect(res.facebook).toMatchObject({ connected: true, importing: true, postCount: 0, syncTriggered: true });
    expect(res.facebook.expectedBy).not.toBeNull();
    expect(res.instagram).toMatchObject({ connected: true, importing: false, postCount: 6 });
  });

  it("marks a platform with no active account as not connected", async () => {
    client.listAccounts.mockResolvedValue([
      { _id: "fb", platform: "facebook", isActive: false, createdAt: new Date().toISOString() },
    ]);
    const res = await svc.importStatus("ws1");
    expect(res.facebook.connected).toBe(false);
    expect(res.instagram.connected).toBe(false);
    expect(client.getSyncInfo).not.toHaveBeenCalled();
  });

  it("still reports importing when Zernio's sync info call fails", async () => {
    client.listAccounts.mockResolvedValue([
      { _id: "fb", platform: "facebook", isActive: true, createdAt: new Date().toISOString() },
    ]);
    client.getSyncInfo.mockRejectedValue(new Error("boom"));
    const res = await svc.importStatus("ws1");
    expect(res.facebook).toMatchObject({ connected: true, importing: true, postCount: null });
  });

  it("returns not-connected for both platforms when the workspace has no Zernio profile", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ zernioProfileId: null });
    const res = await svc.importStatus("ws1");
    expect(res.facebook.connected).toBe(false);
    expect(client.listAccounts).not.toHaveBeenCalled();
  });
});
