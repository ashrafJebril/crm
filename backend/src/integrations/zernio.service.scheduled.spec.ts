import { AiBridgeService } from "./ai-bridge.service";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

/**
 * Ownership guard for cancelling a scheduled post: `cancelScheduledPost`
 * re-derives this workspace's own scheduled queue (via `listScheduledPosts`,
 * which is itself scoped to the workspace's own `zernioProfileId`) and only
 * calls through to `client.cancelPost` when the requested id is actually in
 * it — a postId belonging to another workspace's Zernio profile is never
 * found here, so it 404s instead of being cancelled cross-tenant.
 */
describe("ZernioService.cancelScheduledPost ownership guard", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: { listCreatedPosts: jest.Mock; cancelPost: jest.Mock };
  let svc: ZernioService;

  const workspaceId = "ws1";
  const profileId = "prof1";

  beforeEach(() => {
    prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ zernioProfileId: profileId }),
      },
    };
    client = {
      listCreatedPosts: jest.fn().mockResolvedValue([
        { _id: "mine-1", status: "scheduled", content: "hi", platforms: ["facebook"] },
      ]),
      cancelPost: jest.fn().mockResolvedValue(undefined),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
  });

  it("throws NotFoundException when the post id is not in this workspace's scheduled list", async () => {
    await expect(
      svc.cancelScheduledPost(workspaceId, "someone-elses-post"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.cancelPost).not.toHaveBeenCalled();
  });

  it("calls client.cancelPost when the post id is in this workspace's scheduled list", async () => {
    const res = await svc.cancelScheduledPost(workspaceId, "mine-1");
    expect(client.cancelPost).toHaveBeenCalledWith("mine-1");
    expect(res).toEqual({ ok: true });
  });
});

/**
 * reschedulePost (Strategy A — PUT_WORKS=yes per the 2026-08-13 spike,
 * docs/superpowers/plans/2026-08-13-spike-findings.md). Same ownership-guard
 * shape as cancelScheduledPost: re-derive this workspace's own scheduled
 * queue via `listScheduledPosts` and only call through to `client.updatePost`
 * when the requested id is actually in it, then update the post IN PLACE
 * (same id survives the reschedule — no cancel+recreate needed).
 */
describe("reschedulePost (PUT strategy)", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: { listCreatedPosts: jest.Mock; cancelPost: jest.Mock; updatePost: jest.Mock };
  let svc: ZernioService;

  const workspaceId = "ws1";
  const profileId = "prof1";

  beforeEach(() => {
    prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ zernioProfileId: profileId }),
      },
    };
    client = {
      listCreatedPosts: jest.fn().mockResolvedValue([]),
      cancelPost: jest.fn().mockResolvedValue(undefined),
      updatePost: jest.fn(),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
  });

  it("404s when the post isn't in the workspace queue", async () => {
    client.listCreatedPosts.mockResolvedValue([]);
    await expect(
      svc.reschedulePost("ws1", "nope", "2026-08-20T10:00:00.000Z", "Asia/Riyadh"),
    ).rejects.toThrow(NotFoundException);
    expect(client.updatePost).not.toHaveBeenCalled();
  });

  it("updates the post in place and returns the same id", async () => {
    client.listCreatedPosts.mockResolvedValue([
      { _id: "p1", status: "scheduled", content: "hi", platforms: ["facebook"] },
    ]);
    client.updatePost.mockResolvedValue({ id: "p1", status: "scheduled" });
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await svc.reschedulePost("ws1", "p1", future, "Asia/Riyadh");
    expect(client.updatePost).toHaveBeenCalledWith("p1", {
      scheduledFor: future,
      timezone: "Asia/Riyadh",
    });
    expect(res).toEqual({ ok: true, id: "p1" });
  });

  it("rejects a past scheduledFor with BadRequestException and never calls updatePost", async () => {
    client.listCreatedPosts.mockResolvedValue([
      { _id: "p1", status: "scheduled", content: "hi", platforms: ["facebook"] },
    ]);
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      svc.reschedulePost("ws1", "p1", past, "Asia/Riyadh"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.updatePost).not.toHaveBeenCalled();
  });

  it("rejects a scheduledFor less than 5 minutes out, even if it's technically in the future", async () => {
    client.listCreatedPosts.mockResolvedValue([
      { _id: "p1", status: "scheduled", content: "hi", platforms: ["facebook"] },
    ]);
    const tooSoon = new Date(Date.now() + 60_000).toISOString(); // only 1 minute ahead
    await expect(
      svc.reschedulePost("ws1", "p1", tooSoon, "Asia/Riyadh"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.updatePost).not.toHaveBeenCalled();
  });

  it("still 404s on an unowned post even if the requested time is also invalid", async () => {
    client.listCreatedPosts.mockResolvedValue([]);
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(
      svc.reschedulePost("ws1", "not-mine", past, "Asia/Riyadh"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.updatePost).not.toHaveBeenCalled();
  });
});

/**
 * publish() carries the same "must be far enough in the future" rule when the
 * caller supplies `scheduledFor` — this is the compose-side counterpart to
 * reschedulePost's guard, closed in the same move since both ultimately hit
 * the same Zernio scheduling behavior.
 */
describe("ZernioService.publish schedule guard", () => {
  let prisma: { integration: { findMany: jest.Mock } };
  let media: { mintPublicToken: jest.Mock };
  let client: { createPost: jest.Mock };
  let svc: ZernioService;

  beforeEach(() => {
    prisma = {
      integration: {
        findMany: jest.fn().mockResolvedValue([
          { platform: "facebook", pageId: "acct1" },
        ]),
      },
    };
    media = { mintPublicToken: jest.fn() };
    client = {
      createPost: jest.fn().mockResolvedValue({ id: "post1", status: "scheduled" }),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      media as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
  });

  it("rejects a scheduledFor less than 5 minutes out and never calls createPost", async () => {
    const tooSoon = new Date(Date.now() + 60_000).toISOString();
    await expect(
      svc.publish(
        "ws1",
        { content: "hi", platforms: ["facebook"], scheduledFor: tooSoon },
        "http://localhost:3001",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.createPost).not.toHaveBeenCalled();
  });

  it("still succeeds when scheduledFor is comfortably in the future", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await svc.publish(
      "ws1",
      { content: "hi", platforms: ["facebook"], scheduledFor: future, timezone: "Asia/Riyadh" },
      "http://localhost:3001",
    );
    expect(client.createPost).toHaveBeenCalled();
    expect(res).toEqual({ id: "post1", status: "scheduled" });
  });

  it("still succeeds with no scheduledFor at all (immediate publish)", async () => {
    const res = await svc.publish(
      "ws1",
      { content: "hi", platforms: ["facebook"] },
      "http://localhost:3001",
    );
    expect(client.createPost).toHaveBeenCalled();
    expect(res).toEqual({ id: "post1", status: "scheduled" });
  });
});
