import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";
import { ChannelResolver } from "../channels/channel-resolver.service";

/**
 * Lead attribution for comment auto-reply.
 *
 * `comment.received` is NOT a trigger. Zernio's automation decides privately
 * which comments it answers and never tells us, so this event exists only to
 * record where a lead came from — which reel, and which ad.
 *
 * The link to a contact happens later: the commenter's platform user id in
 * `comment.received` is the SAME id that arrives as the conversation
 * participant when they reply to the DM. That identity is the whole mechanism.
 */
const WS = "ws-1";

function build() {
  const prisma: any = {
    commentLead: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const channels = {
    forInbound: jest.fn().mockResolvedValue({ id: "ch-1", workspaceId: WS, kind: "instagram" }),
  };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
    {} as unknown as MediaService,
    {} as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
    undefined, // events
    undefined, // paymentLock
    channels as unknown as ChannelResolver,
  );
  return { svc, prisma, channels };
}

const commentEvent = () => ({
  type: "comment.received",
  account: { accountId: "acc-1", platform: "instagram" },
  comment: {
    id: "cmt-1",
    platform: "instagram",
    text: "كيوي",
    author: { id: "igsid-9", name: "Fatima", username: "fatima" },
    platformPostId: "media-7",
  },
  post: { id: "post-1", platformPostId: "media-7", permalink: "https://instagram.com/p/x" },
});

/**
 * A second rig, for the OTHER half of attribution: the inbound DM that turns a
 * commenter into a contact. `leadsLinked` is what `commentLead.updateMany`
 * reports — 1 means this person had commented before, 0 means they had not.
 */
function buildInbound(opts: { handoffToAgent: boolean; leadsLinked: number }) {
  const prisma: any = {
    message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: "m-1" }) },
    contact: { upsert: jest.fn().mockResolvedValue({ id: "contact-1", phone: null }), update: jest.fn() },
    conversation: {
      // No existing thread → ingestInbound creates one, which is the only
      // case where the handover is allowed to touch aiEnabled.
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "conv-1", externalId: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    commentLead: { updateMany: jest.fn().mockResolvedValue({ count: opts.leadsLinked }) },
    commentAutoReply: {
      findUnique: jest.fn().mockResolvedValue({ handoffToAgent: opts.handoffToAgent }),
    },
    workspace: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const channels = {
    forInbound: jest.fn().mockResolvedValue({ id: "ch-1", workspaceId: WS, kind: "instagram" }),
    findOrAdoptConversation: jest.fn().mockResolvedValue(null),
    touchInbound: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
    {} as unknown as MediaService,
    {} as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
    undefined,
    undefined,
    channels as unknown as ChannelResolver,
  );
  return { svc, prisma, channels };
}

const inboundEvent = () => ({
  type: "message.received",
  account: { accountId: "acc-1", platform: "instagram" },
  conversation: { id: "z-conv-1", participantId: "igsid-9", participantName: "Fatima" },
  message: { id: "m-1", text: "عندي مطعم", platform: "instagram" },
});

describe("ZernioService — comment lead attribution", () => {
  it("records the comment, the post and the ad it came from", async () => {
    const { svc, prisma } = build();
    await svc.handleEvent({
      type: "comment.received",
      account: { accountId: "acc-1", platform: "instagram" },
      comment: {
        id: "cmt-1",
        platform: "instagram",
        text: "كيوي",
        author: { id: "igsid-9", name: "Fatima" },
        platformPostId: "media-7",
        // Present only on comments left on PAID content — this is what makes
        // "which ad produced this lead" answerable at all.
        ad: { id: "ad-42", title: "Kewy Pass reel", isDarkPost: true },
      },
      post: { id: "post-1", platformPostId: "media-7", permalink: "https://instagram.com/p/x" },
    });

    expect(prisma.commentLead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          workspaceId: WS,
          commentId: "cmt-1",
          authorId: "igsid-9",
          authorName: "Fatima",
          platform: "instagram",
          adId: "ad-42",
          adTitle: "Kewy Pass reel",
          isDarkPost: true,
          permalink: "https://instagram.com/p/x",
        }),
      }),
    );
  });

  it("is idempotent — a redelivered comment updates nothing", async () => {
    // Zernio retries for ~51 hours, so at-least-once delivery is normal.
    const { svc, prisma } = build();
    await svc.handleEvent(commentEvent() as never);
    expect(prisma.commentLead.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_commentId: { workspaceId: WS, commentId: "cmt-1" } },
        update: {},
      }),
    );
  });

  it("ignores a comment on an account we don't know", async () => {
    const { svc, prisma, channels } = build();
    channels.forInbound.mockResolvedValue(null);
    const res = await svc.handleEvent(commentEvent() as never);
    expect(prisma.commentLead.upsert).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true });
  });

  it("never fails the webhook when the write blows up", async () => {
    // A non-200 makes Zernio retry for two days. A missing attribution row is
    // a far smaller problem than a redelivery storm.
    const { svc, prisma } = build();
    prisma.commentLead.upsert.mockRejectedValue(new Error("db down"));
    await expect(svc.handleEvent(commentEvent() as never)).resolves.toMatchObject({ ok: true });
  });

  describe("linking a lead to the contact it became", () => {
    it("arms the AI agent on the new thread when the rule asks for it", async () => {
      // Otherwise the card's "hand over to the AI agent" switch is decorative:
      // the agent reply path only ever looks at conv.aiEnabled.
      const { svc, prisma } = buildInbound({ handoffToAgent: true, leadsLinked: 1 });
      await svc.handleEvent(inboundEvent() as never);
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { aiEnabled: true } }),
      );
    });

    it("leaves the thread alone when the rule does not ask for a handover", async () => {
      const { svc, prisma } = buildInbound({ handoffToAgent: false, leadsLinked: 1 });
      await svc.handleEvent(inboundEvent() as never);
      expect(prisma.conversation.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { aiEnabled: true } }),
      );
    });

    it("does not arm anything for someone who never commented", async () => {
      // No lead row matched, so this inbound DM has nothing to do with the
      // comment rule and must not inherit its AI setting.
      const { svc, prisma } = buildInbound({ handoffToAgent: true, leadsLinked: 0 });
      await svc.handleEvent(inboundEvent() as never);
      expect(prisma.commentAutoReply.findUnique).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { aiEnabled: true } }),
      );
    });
  });

  it("ignores a malformed event with no author or comment id", async () => {
    const { svc, prisma } = build();
    await svc.handleEvent({
      type: "comment.received",
      account: { accountId: "acc-1" },
      comment: { text: "hi" },
    } as never);
    expect(prisma.commentLead.upsert).not.toHaveBeenCalled();
  });
});
