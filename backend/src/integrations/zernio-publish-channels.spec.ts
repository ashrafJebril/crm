import { ZernioService } from "./zernio.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * SP-19 m7: social publishing honours a hub disconnect (R9). A platform whose
 * Zernio account's channel the user disconnected in the hub is not posted to.
 */
describe("ZernioService.publish skips accounts disconnected in the hub", () => {
  const integ = (id: string, platform: string, pageId: string) => ({
    id,
    workspaceId: "ws1",
    platform,
    provider: "zernio",
    pageId,
    pageName: platform,
    createdAt: new Date(),
  });
  const ch = (id: string, kind: string, externalId: string, over: Record<string, unknown> = {}) => ({
    id,
    workspaceId: "ws1",
    kind,
    provider: "zernio",
    externalId,
    displayName: kind,
    status: "active",
    statusReason: null,
    isDefault: true,
    integrationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  function build(channels: unknown[]) {
    const prisma = makeFakePrisma({
      integration: [integ("i1", "facebook", "acc-FB"), integ("i2", "instagram", "acc-IG")],
      channel: channels,
    } as never);
    const client = { createPost: jest.fn(async () => ({ id: "post1", status: "published" })) };
    const svc = new ZernioService(
      prisma,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      client as never,
      {} as never,
      { enabled: false } as never,
      {} as never,
    );
    return { svc, client };
  }

  it("posts to connected accounts only", async () => {
    const { svc, client } = build([
      ch("c1", "facebook", "acc-FB", { status: "disconnected", statusReason: "disconnected_by_user", isDefault: false }),
      ch("c2", "instagram", "acc-IG"),
    ]);
    await svc.publish("ws1", { content: "hi", platforms: ["facebook", "instagram"] }, "https://api.example.com");
    expect(client.createPost).toHaveBeenCalledWith(
      expect.objectContaining({ platforms: [{ platform: "instagram", accountId: "acc-IG" }] }),
    );
  });

  it("refuses when every requested account was disconnected in the hub", async () => {
    const { svc, client } = build([
      ch("c1", "facebook", "acc-FB", { status: "disconnected", statusReason: "disconnected_by_user", isDefault: false }),
    ]);
    await expect(
      svc.publish("ws1", { content: "hi", platforms: ["facebook"] }, "https://api.example.com"),
    ).rejects.toThrow(/No connected/);
    expect(client.createPost).not.toHaveBeenCalled();
  });

  it("other disconnect reasons and unmirrored accounts keep main's behaviour", async () => {
    const { svc, client } = build([
      ch("c1", "facebook", "acc-FB", { status: "disconnected", statusReason: "zernio_account_missing", isDefault: false }),
    ]);
    await svc.publish("ws1", { content: "hi", platforms: ["facebook", "instagram"] }, "https://api.example.com");
    expect(client.createPost).toHaveBeenCalledWith(
      expect.objectContaining({
        platforms: [
          { platform: "facebook", accountId: "acc-FB" },
          { platform: "instagram", accountId: "acc-IG" },
        ],
      }),
    );
  });
});
