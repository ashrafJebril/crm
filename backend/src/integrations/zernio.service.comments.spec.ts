import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";

/**
 * Ownership guard for comment reply/delete: workspace tenancy must hold even
 * when the caller omits accountId. See task-4 fix-round-1 brief — the Zernio
 * API key is global across workspaces, so an omitted accountId used to no-op
 * the guard entirely and let any workspace act on any other workspace's
 * comment as long as it knew the commentId.
 *
 * Fix round 2 (2026-08-12): live E2E proved the round-1 endpoint paths wrong
 * (`POST /inbox/comments/{commentId}/reply` 405s; `DELETE
 * /inbox/comments/{commentId}` 400s missing `commentId`). The real API
 * addresses the PARENT POST id in the path, with `accountId` + `commentId`
 * as separate params — so the service must resolve a comment's owning
 * `postId` (and `accountId`) from this workspace's own live comment feed
 * before it can call the client at all. That lookup doubles as the tenancy
 * guard: a commentId from another workspace's feed simply isn't found here.
 */
describe("ZernioService comment ownership guard", () => {
  let prisma: { workspace: { findUnique: jest.Mock }; integration: { findFirst: jest.Mock } };
  let client: {
    listComments: jest.Mock;
    getPostComments: jest.Mock;
    replyToComment: jest.Mock;
    deleteComment: jest.Mock;
  };
  let svc: ZernioService;

  const workspaceId = "ws1";
  const profileId = "prof1";

  beforeEach(() => {
    prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ zernioProfileId: profileId }),
      },
      integration: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    client = {
      listComments: jest
        .fn()
        .mockResolvedValue([{ id: "p1", accountId: "acc1", platform: "facebook", commentCount: 1 }]),
      getPostComments: jest.fn().mockResolvedValue([{ id: "c1", message: "hi", from: { name: "X" } }]),
      replyToComment: jest.fn().mockResolvedValue({ id: "reply1" }),
      deleteComment: jest.fn().mockResolvedValue(undefined),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
    );
  });

  it("throws NotFoundException when accountId belongs to another workspace", async () => {
    prisma.integration.findFirst.mockResolvedValue(null); // not in this workspace
    await expect(
      svc.replyToComment(workspaceId, "c1", "hi", "foreign-acc"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.replyToComment).not.toHaveBeenCalled();

    await expect(
      svc.deleteComment(workspaceId, "c1", "foreign-acc"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.deleteComment).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when the commentId isn't in this workspace's live comment feed", async () => {
    client.getPostComments.mockResolvedValue([{ id: "someone-elses-comment", message: "hi" }]);

    await expect(
      svc.replyToComment(workspaceId, "c1", "hi"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.replyToComment).not.toHaveBeenCalled();

    await expect(svc.deleteComment(workspaceId, "c1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(client.deleteComment).not.toHaveBeenCalled();
  });

  it("resolves postId + accountId from the workspace's own feed and calls through to the client", async () => {
    const res = await svc.replyToComment(workspaceId, "c1", "hi");
    expect(client.getPostComments).toHaveBeenCalledWith("p1", "acc1");
    expect(client.replyToComment).toHaveBeenCalledWith("p1", "acc1", "hi", "c1");
    expect(res).toEqual({ id: "reply1" });

    const del = await svc.deleteComment(workspaceId, "c1");
    expect(client.deleteComment).toHaveBeenCalledWith("p1", "acc1", "c1");
    expect(del).toEqual({ ok: true });
  });

  it("uses the caller-supplied accountId (once verified) over the feed's resolved one", async () => {
    prisma.integration.findFirst.mockResolvedValue({ id: "integ1" }); // owns "acc-explicit"
    await svc.replyToComment(workspaceId, "c1", "hi", "acc-explicit");
    expect(client.replyToComment).toHaveBeenCalledWith("p1", "acc-explicit", "hi", "c1");
  });

  it("resolves the post id via the post's _id fallback field", async () => {
    client.listComments.mockResolvedValue([
      { _id: "p1", accountId: "acc1", platform: "facebook", commentCount: 1 },
    ]);
    await expect(svc.replyToComment(workspaceId, "c1", "hi")).resolves.toEqual({
      id: "reply1",
    });
    expect(client.replyToComment).toHaveBeenCalledWith("p1", "acc1", "hi", "c1");
  });

  it("throws BadRequestException when the workspace has no Zernio profile", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ zernioProfileId: null });

    await expect(
      svc.replyToComment(workspaceId, "c1", "hi"),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.deleteComment(workspaceId, "c1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.listComments).not.toHaveBeenCalled();
  });
});

/**
 * Fix round 2: `GET /inbox/comments` (no path param) returns POSTS with
 * comment counts, not individual comments (confirmed via
 * https://docs.zernio.com/comments/list-inbox-comments and a live probe —
 * rows carried the post's own caption as `content`, no author, `commentCount`
 * instead of a body). The old mapping treated those post rows as comments
 * directly, so every row showed author "User", `postId: null`, and a body
 * identical to the parent post's caption. The fix fetches each post's real
 * comments via `getPostComments` and flattens them into genuine comment rows.
 */
describe("ZernioService listComments (genuine per-post comment shape)", () => {
  let prisma: { workspace: { findUnique: jest.Mock } };
  let client: { listComments: jest.Mock; getPostComments: jest.Mock };
  let svc: ZernioService;

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ zernioProfileId: "prof1" }) },
    };
    client = {
      listComments: jest.fn(),
      getPostComments: jest.fn(),
    };
    svc = new ZernioService(
      prisma as unknown as PrismaService,
      {} as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
    );
  });

  it("fetches real comments only for posts with commentCount > 0, and maps genuine fields", async () => {
    client.listComments.mockResolvedValue([
      {
        id: "p1",
        accountId: "acc1",
        platform: "facebook",
        content: "the post's own caption — must NOT leak into a comment body",
        commentCount: 1,
      },
      {
        id: "p2",
        accountId: "acc2",
        platform: "instagram",
        content: "another caption",
        commentCount: 0,
      },
    ]);
    client.getPostComments.mockResolvedValue([
      {
        id: "cmt1",
        message: "great post!",
        from: { name: "Jane Doe" },
        likeCount: 3,
        createdTime: "2026-01-01T00:00:00Z",
      },
    ]);

    const rows = await svc.listComments("ws1");

    expect(client.getPostComments).toHaveBeenCalledTimes(1);
    expect(client.getPostComments).toHaveBeenCalledWith("p1", "acc1");
    expect(rows).toEqual([
      {
        id: "cmt1",
        postId: "p1",
        platform: "facebook",
        author: "Jane Doe",
        body: "great post!",
        likes: 3,
        at: "2026-01-01T00:00:00Z",
        accountId: "acc1",
      },
    ]);
  });

  it("returns no rows when no posts have comments (and never calls getPostComments)", async () => {
    client.listComments.mockResolvedValue([
      { id: "p1", accountId: "acc1", platform: "facebook", commentCount: 0 },
    ]);
    const rows = await svc.listComments("ws1");
    expect(rows).toEqual([]);
    expect(client.getPostComments).not.toHaveBeenCalled();
  });

  it("falls back to the comment's own username when no display name is present", async () => {
    client.listComments.mockResolvedValue([
      { id: "p1", accountId: "acc1", platform: "facebook", commentCount: 1 },
    ]);
    client.getPostComments.mockResolvedValue([
      { id: "cmt1", message: "hey", from: { username: "handle_only" } },
    ]);
    const rows = await svc.listComments("ws1");
    expect(rows[0].author).toBe("handle_only");
  });
});
