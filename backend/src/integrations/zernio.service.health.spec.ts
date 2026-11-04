import { ZernioService } from "./zernio.service";

const deadWa = {
  _id: "wa-old",
  platform: "whatsapp",
  displayName: "samemha_jo",
  isActive: false,
  platformStatus: "active",
  metadata: { metaDeletedAt: "2026-09-14T02:17:55.493Z" },
};
const liveWa = { _id: "wa-new", platform: "whatsapp", displayName: "samemha_jo", isActive: true, platformStatus: "active", metadata: {} };
const liveFb = { _id: "fb-1", platform: "facebook", displayName: "Samemha", isActive: true, platformStatus: "active", metadata: {} };

function build(accounts: unknown[] | Error) {
  const rows = [
    { platform: "facebook", pageId: "fb-1", pageName: "Samemha", updatedAt: new Date("2026-08-17") },
    { platform: "whatsapp", pageId: "wa-old", pageName: "samemha_jo", updatedAt: new Date("2026-08-17") },
  ];
  const prisma = {
    integration: { findMany: jest.fn().mockResolvedValue(rows), upsert: jest.fn().mockResolvedValue({}) },
    workspace: { findUnique: jest.fn().mockResolvedValue({ id: "ws1", zernioProfileId: "prof1" }) },
  };
  const listAccounts =
    accounts instanceof Error ? jest.fn().mockRejectedValue(accounts) : jest.fn().mockResolvedValue(accounts);
  const client = { isConfigured: () => true, listAccounts };
  const svc = new ZernioService(
    prisma as never,
    { emitToWorkspace: jest.fn() } as never,
    {} as never,
    client as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma, listAccounts };
}

describe("ZernioService.status — account health", () => {
  it("reports an account Meta removed as needing a reconnect, keeping the rest of the shape", async () => {
    const { svc } = build([liveFb, deadWa]);
    const res = await svc.status("ws1");
    expect(res.accounts).toEqual([
      expect.objectContaining({ platform: "facebook", accountId: "fb-1", health: "ok", healthReason: null }),
      expect.objectContaining({
        platform: "whatsapp",
        accountId: "wa-old",
        name: "samemha_jo",
        health: "reconnect",
        healthReason: expect.stringMatching(/Meta removed access on 2026-09-14/),
      }),
    ]);
  });

  it("says 'unknown' rather than raising an alarm when Zernio can't be reached", async () => {
    const { svc } = build(new Error("Zernio API timed out"));
    const res = await svc.status("ws1");
    expect(res.accounts.map((a) => a.health)).toEqual(["unknown", "unknown"]);
  });

  it("caches Zernio's answer for a few minutes so busy screens don't hammer it", async () => {
    const { svc, listAccounts } = build([liveFb, deadWa]);
    await svc.status("ws1");
    await svc.status("ws1");
    expect(listAccounts).toHaveBeenCalledTimes(1);
  });
});

describe("ZernioService.syncAccounts — reconnecting", () => {
  it("links the healthy account when Zernio still lists the dead one first", async () => {
    const { svc, prisma } = build([deadWa, liveWa]);
    const res = await svc.syncAccounts("ws1");
    expect(res.connected).toEqual([{ platform: "whatsapp", accountId: "wa-new", name: "samemha_jo" }]);
    expect(prisma.integration.upsert.mock.calls[0][0].update.pageId).toBe("wa-new");
  });

  it("shows the fresh state right after syncing, without waiting for the cache", async () => {
    const { svc, listAccounts } = build([liveFb, deadWa]);
    expect((await svc.status("ws1")).accounts[1].health).toBe("reconnect");
    // The customer reconnected: Zernio now reports the same account healthy.
    listAccounts.mockResolvedValue([liveFb, { ...deadWa, isActive: true, metadata: {} }]);
    await svc.syncAccounts("ws1");
    expect((await svc.status("ws1")).accounts[1].health).toBe("ok");
  });
});
