import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";
import type { Channel } from "@prisma/client";

/**
 * Disconnecting a channel in the hub now disconnects it at Zernio too.
 *
 * It used to only mark our row, which surprised people ("I disconnected it,
 * why is it still linked?") and meant reconnecting never re-ran Zernio's
 * freshly-connected backfill of existing native posts.
 *
 * It covers WhatsApp too, decided knowingly: a disconnect that leaves the
 * account live at Zernio is worse than one that bites, because customers
 * believe they have stopped something they have not.
 *
 * What that costs, so nobody widens or narrows this set by accident: Zernio's
 * disconnect is a HARD DELETE after a one-hour grace window, with no
 * reversible disable in their API. For WhatsApp it can reach a number the
 * customer pays for monthly, and Zernio does not document whether deleting
 * releases it — which is why the hub's confirm dialog says so outright.
 */
function build() {
  const client: any = {
    isConfigured: () => true,
    disconnectAccount: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ZernioService(
    { workspace: { findUnique: jest.fn() } } as unknown as PrismaService,
    { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
    {} as unknown as MediaService,
    client as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn() } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
  );
  return { svc, client };
}

const channel = (over: Partial<Channel> = {}) =>
  ({
    id: "ch-1",
    workspaceId: "ws-1",
    kind: "facebook",
    provider: "zernio",
    externalId: "acc-fb",
    ...over,
  }) as Channel;

describe("ZernioService — hub disconnect reaches Zernio", () => {
  it.each(["facebook", "instagram", "tiktok", "whatsapp"])("removes the %s account", async (kind) => {
    const { svc, client } = build();
    await svc.disconnectAccountAtZernio(channel({ kind, externalId: `acc-${kind}` }));
    expect(client.disconnectAccount).toHaveBeenCalledWith(`acc-${kind}`);
  });

  it("leaves an unknown platform alone", async () => {
    // Only the platforms we have reasoned about are removed upstream; anything
    // new keeps the old soft disconnect until someone decides deliberately.
    const { svc, client } = build();
    await svc.disconnectAccountAtZernio(channel({ kind: "snapchat", externalId: "acc-sc" }));
    expect(client.disconnectAccount).not.toHaveBeenCalled();
  });

  it("does nothing without an account id", async () => {
    const { svc, client } = build();
    await svc.disconnectAccountAtZernio(channel({ externalId: null }));
    expect(client.disconnectAccount).not.toHaveBeenCalled();
  });

  it("does nothing when Zernio is not configured", async () => {
    const { svc, client } = build();
    client.isConfigured = () => false;
    await svc.disconnectAccountAtZernio(channel());
    expect(client.disconnectAccount).not.toHaveBeenCalled();
  });

  it("lets a failure surface to the caller's best-effort teardown", async () => {
    // ChannelsService.disconnect already catches and logs; our row is
    // disconnected either way, so the worst case is the old behaviour.
    const { svc, client } = build();
    client.disconnectAccount.mockRejectedValue(new Error("502 from Zernio"));
    await expect(svc.disconnectAccountAtZernio(channel())).rejects.toThrow("502 from Zernio");
  });
});
