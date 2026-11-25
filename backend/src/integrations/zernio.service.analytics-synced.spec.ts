import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";

/**
 * `analytics.synced` — Zernio has finished pulling a page's OWN posts.
 *
 * Why this matters: the Social feed reads Zernio's `/analytics`, which serves
 * only what Zernio has ALREADY synced, and hitting it merely *triggers* the
 * sync rather than waiting for it. So a post made directly in Instagram is
 * genuinely missing from the response that went looking for it.
 *
 * Confirmed in production on 2026-11-25: both `/analytics` and
 * `/external-posts` returned the same 6 posts — newest from the previous day —
 * while a post made that morning appeared in neither. The feed was correct and
 * still looked broken. This event is how we learn it is worth asking again.
 */
const WS = "ws-1";
const PROFILE = "prof-1";

function build(workspace: { id: string } | null = { id: WS }) {
  const prisma: any = {
    workspace: { findFirst: jest.fn().mockResolvedValue(workspace) },
  };
  const realtime: any = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    {} as unknown as MediaService,
    {} as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
  );
  return { svc, prisma, realtime };
}

describe("ZernioService — analytics.synced", () => {
  it("tells the workspace its feed is worth refetching", async () => {
    const { svc, prisma, realtime } = build();
    await svc.handleEvent({ type: "analytics.synced", data: { profileId: PROFILE } } as never);
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { zernioProfileId: PROFILE } }),
    );
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
  });

  it.each([
    ["data envelope", { data: { profileId: PROFILE } }],
    ["account envelope", { account: { profileId: PROFILE } }],
    ["root field", { profileId: PROFILE }],
  ])("finds the profile id in the %s", async (_label, body) => {
    // The event's shape is undocumented, so all three placements are accepted
    // rather than guessing one and silently doing nothing.
    const { svc, realtime } = build();
    await svc.handleEvent({ type: "analytics.synced", ...body } as never);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith(WS, "social.updated", {});
  });

  it("stays quiet for a profile that is not ours", async () => {
    // The Zernio API key is shared, so events can arrive for profiles no
    // workspace here owns. Emitting would refresh an unrelated tenant.
    const { svc, realtime } = build(null);
    const res = await svc.handleEvent({
      type: "analytics.synced",
      data: { profileId: "someone-else" },
    } as never);
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true });
  });

  it("acks an event with no profile id instead of failing the webhook", async () => {
    // A non-200 makes Zernio retry for ~51 hours; a missed refresh does not
    // justify that.
    const { svc, prisma, realtime } = build();
    const res = await svc.handleEvent({ type: "analytics.synced" } as never);
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true });
  });
});
