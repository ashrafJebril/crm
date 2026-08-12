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
 */
describe("ZernioService comment ownership guard", () => {
  let prisma: { workspace: { findUnique: jest.Mock }; integration: { findFirst: jest.Mock } };
  let client: { listComments: jest.Mock; replyToComment: jest.Mock; deleteComment: jest.Mock };
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
      listComments: jest.fn().mockResolvedValue([{ id: "c1", accountId: "acc1" }]),
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

  it("throws NotFoundException when accountId is omitted and the comment isn't in this workspace's feed", async () => {
    client.listComments.mockResolvedValue([{ id: "someone-elses-comment" }]);

    await expect(
      svc.replyToComment(workspaceId, "c1", "hi"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(client.replyToComment).not.toHaveBeenCalled();

    await expect(svc.deleteComment(workspaceId, "c1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(client.deleteComment).not.toHaveBeenCalled();
  });

  it("calls through to the client when accountId is omitted and the comment IS in this workspace's feed", async () => {
    client.listComments.mockResolvedValue([{ id: "c1", accountId: "acc1" }]);

    const res = await svc.replyToComment(workspaceId, "c1", "hi");
    expect(client.replyToComment).toHaveBeenCalledWith("c1", "hi", undefined);
    expect(res).toEqual({ id: "reply1" });

    const del = await svc.deleteComment(workspaceId, "c1");
    expect(client.deleteComment).toHaveBeenCalledWith("c1", undefined);
    expect(del).toEqual({ ok: true });
  });

  it("also matches on the comment's _id field, not just id", async () => {
    client.listComments.mockResolvedValue([{ _id: "c1", accountId: "acc1" }]);
    await expect(svc.replyToComment(workspaceId, "c1", "hi")).resolves.toEqual({
      id: "reply1",
    });
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
