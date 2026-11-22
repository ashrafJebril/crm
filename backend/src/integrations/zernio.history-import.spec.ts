import { NotFoundException } from "@nestjs/common";
import { HISTORY_IMPORT_THROTTLE_MS, ZernioService } from "./zernio.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * On-demand history import for one conversation (POST
 * /integrations/zernio/db-conversations/:id/import-history): a Zernio thread
 * synced as a preview with no Message rows fills itself when opened.
 */

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "instagram",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: id,
  status: "active",
  isDefault: true,
  integrationId: null,
  config: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const conv = (over: Record<string, unknown> = {}) => ({
  id: "cv1",
  workspaceId: "ws1",
  contactId: "c1",
  channel: "instagram",
  channelId: "IG",
  externalId: "zc-1",
  preview: "hello from the list",
  lastFrom: "them",
  lastAt: "2d",
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const zMessages = () => [
  { id: "m1", direction: "incoming", message: "hello", createdAt: "2026-03-01T10:00:00Z" },
  { id: "m2", direction: "outgoing", message: "hi, how can we help?", createdAt: "2026-03-01T10:05:00Z" },
];

function world(seed: Parameters<typeof makeFakePrisma>[0] = {}) {
  const prisma = makeFakePrisma({
    workspace: [{ id: "ws1", zernioProfileId: "prof" }],
    channel: [ch("IG")],
    conversation: [conv()],
    message: [],
    ...seed,
  });
  const client = {
    isConfigured: () => true,
    getMessages: jest.fn(async () => zMessages()),
    listConversations: jest.fn(async () => [] as unknown[]),
    downloadMedia: jest.fn(),
  };
  const realtime = { emitToWorkspace: jest.fn() };
  const svc = new ZernioService(
    prisma,
    realtime as never,
    {} as never,
    client as never,
    { onInboundMessage: jest.fn(async () => {}), onOutboundReply: jest.fn(async () => {}) } as never,
    { enabled: false } as never,
    { isConfigured: () => false } as never,
  );
  return { prisma, client, realtime, svc };
}

afterEach(() => jest.restoreAllMocks());

describe("importHistoryForConversation", () => {
  it("imports the thread's messages, refreshes the row and emits inbox.activity for it", async () => {
    const { prisma, client, realtime, svc } = world();
    const res = await svc.importHistoryForConversation("ws1", "cv1");
    expect(res).toEqual({ imported: 2, skipped: 0 });
    expect(client.getMessages).toHaveBeenCalledWith("zc-1", "acc-IG");
    expect(prisma.db.message.map((m: { body: string }) => m.body)).toEqual(["hello", "hi, how can we help?"]);
    expect(prisma.db.message.every((m: { conversationId: string }) => m.conversationId === "cv1")).toBe(true);
    const row = prisma.db.conversation[0];
    expect(row.preview).toBe("hi, how can we help?");
    expect(row.lastFrom).toBe("human");
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", {
      channel: "instagram",
      channelId: "IG",
      conversationId: "cv1",
    });
  });

  it("is idempotent: a second run (after the throttle) skips every message already held", async () => {
    const { prisma, realtime, svc } = world();
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    await svc.importHistoryForConversation("ws1", "cv1");
    realtime.emitToWorkspace.mockClear();
    clock.mockReturnValue(now + HISTORY_IMPORT_THROTTLE_MS + 1);
    const res = await svc.importHistoryForConversation("ws1", "cv1");
    expect(res).toEqual({ imported: 0, skipped: 2 });
    expect(prisma.db.message).toHaveLength(2);
    // Nothing new: no event.
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
  });

  it("skips a webhook-era row with another id by the body+timestamp fuzzy match", async () => {
    const { prisma, svc } = world({
      message: [
        {
          id: "old",
          workspaceId: "ws1",
          conversationId: "cv1",
          from: "them",
          body: "hello",
          metaMessageId: "zernio-internal-77",
          createdAt: new Date("2026-03-01T10:00:40Z"),
        },
      ],
    });
    const res = await svc.importHistoryForConversation("ws1", "cv1");
    expect(res).toEqual({ imported: 1, skipped: 1 });
    expect(prisma.db.message.filter((m: { body: string }) => m.body === "hello")).toHaveLength(1);
  });

  it("throttles: one import per conversation per window, other conversations unaffected", async () => {
    const { prisma, client, svc } = world();
    prisma.db.conversation.push(conv({ id: "cv2", externalId: "zc-2" }));
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now);
    await svc.importHistoryForConversation("ws1", "cv1");
    clock.mockReturnValue(now + HISTORY_IMPORT_THROTTLE_MS - 1);
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({ imported: 0, skipped: 0, reason: "throttled" });
    expect(client.getMessages).toHaveBeenCalledTimes(1);
    // A different conversation is its own window.
    await svc.importHistoryForConversation("ws1", "cv2");
    expect(client.getMessages).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(now + HISTORY_IMPORT_THROTTLE_MS);
    await svc.importHistoryForConversation("ws1", "cv1");
    expect(client.getMessages).toHaveBeenCalledTimes(3);
  });

  it("a failed Zernio call does not hold the throttle (a manual retry may try again)", async () => {
    const { client, svc } = world();
    client.getMessages.mockRejectedValueOnce(new Error("zernio down"));
    await expect(svc.importHistoryForConversation("ws1", "cv1")).rejects.toThrow("zernio down");
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({ imported: 2, skipped: 0 });
  });

  it("refuses a non-Zernio conversation without calling Zernio", async () => {
    const { client, svc } = world({
      channel: [ch("TG", { kind: "telegram", provider: "telegram", externalId: "bot-1" })],
      conversation: [conv({ channel: "telegram", channelId: "TG" })],
    });
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({ imported: 0, skipped: 0, reason: "not_zernio" });
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it("refuses a conversation with no Zernio conversation id (externalId)", async () => {
    const { client, svc } = world({ conversation: [conv({ externalId: null })] });
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({ imported: 0, skipped: 0, reason: "no_external_id" });
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it("refuses a conversation whose channel is disconnected", async () => {
    const { client, svc } = world({ channel: [ch("IG", { status: "disconnected" })] });
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({
      imported: 0,
      skipped: 0,
      reason: "channel_unavailable",
    });
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it("404s a conversation of another workspace", async () => {
    const { client, svc } = world({ conversation: [conv({ workspaceId: "ws2" })] });
    await expect(svc.importHistoryForConversation("ws1", "cv1")).rejects.toBeInstanceOf(NotFoundException);
    expect(client.getMessages).not.toHaveBeenCalled();
  });

  it("an import that finds nothing leaves the row (preview, order) untouched", async () => {
    const { prisma, client, realtime, svc } = world();
    client.getMessages.mockResolvedValueOnce([]);
    expect(await svc.importHistoryForConversation("ws1", "cv1")).toEqual({ imported: 0, skipped: 0 });
    expect(prisma.db.conversation[0].preview).toBe("hello from the list");
    expect(prisma.db.conversation[0].updatedAt).toEqual(new Date("2026-01-01"));
    expect(realtime.emitToWorkspace).not.toHaveBeenCalled();
  });
});

describe("one shared message-import helper", () => {
  it("the on-demand import and the workspace backfill both go through importConversationMessages", async () => {
    const { prisma, client, svc } = world({
      contact: [{ id: "c1", workspaceId: "ws1", externalSource: "instagram", externalId: "ig-user", phone: null }],
    });
    const helper = jest.spyOn(svc, "importConversationMessages");

    await svc.importHistoryForConversation("ws1", "cv1");
    expect(helper).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenLastCalledWith("ws1", "cv1", "zc-1", "acc-IG", "instagram", { refreshSummary: "if-inserted" });

    client.listConversations.mockResolvedValueOnce([
      { id: "zc-1", platform: "instagram", participantId: "ig-user", accountId: "acc-IG" },
    ]);
    const counts = await svc.backfillHistory("ws1");
    expect(helper).toHaveBeenCalledTimes(2);
    expect(helper).toHaveBeenLastCalledWith("ws1", "cv1", "zc-1", "acc-IG", "instagram");
    // Already imported above: the backfill adds nothing twice.
    expect(counts.messagesInserted).toBe(0);
    expect(counts.messagesSkipped).toBe(2);
    expect(prisma.db.message).toHaveLength(2);
  });
});
