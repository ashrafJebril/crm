import { InboundSinkService } from "./inbound-sink.service";
import { WORKFLOW_TRIGGER_EVENT } from "../workflows/workflow-events";
import { makeFakePrisma } from "./test-prisma";

const channel = {
  id: "T",
  workspaceId: "ws1",
  kind: "telegram",
  provider: "telegram",
  externalId: "bot",
  displayName: "Bot",
  status: "active",
  isDefault: true,
  integrationId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function build() {
  const prisma = makeFakePrisma({ channel: [{ ...channel }] });
  const realtime = { emitToWorkspace: jest.fn() };
  const pipeline = { onInboundMessage: jest.fn(async () => {}) };
  const events = { emit: jest.fn() };
  const svc = new InboundSinkService(prisma, realtime as never, pipeline as never, events as never);
  return { prisma, svc, realtime, pipeline, events };
}

const input = (over: Record<string, unknown> = {}) => ({
  workspaceId: "ws1",
  channel: channel as never,
  externalSource: "telegram",
  externalId: "chat-1",
  contactName: "Sara",
  text: "hello",
  providerMessageId: "tg:T:1",
  at: new Date("2026-11-09T10:00:00Z"),
  ...over,
});

describe("InboundSinkService.record", () => {
  it("writes contact, channel conversation and message, then fires the Zernio-path side effects", async () => {
    const { prisma, svc, realtime, pipeline, events } = build();
    const res = await svc.record(input());
    expect(res.duplicate).toBe(false);
    expect(prisma.db.contact[0]).toMatchObject({ externalSource: "telegram", externalId: "chat-1", name: "Sara" });
    expect(prisma.db.conversation[0]).toMatchObject({ id: res.conversationId, channelId: "T", channel: "telegram", unread: 1 });
    expect(prisma.db.message[0]).toMatchObject({ id: res.messageId, from: "them", body: "hello", metaMessageId: "tg:T:1" });
    expect(prisma.db.channel[0].lastInboundAt).toBeInstanceOf(Date);
    expect(realtime.emitToWorkspace).toHaveBeenCalledWith("ws1", "inbox.activity", {
      channel: "telegram",
      channelId: "T",
      conversationId: res.conversationId,
    });
    expect(pipeline.onInboundMessage).toHaveBeenCalledWith(
      "ws1",
      prisma.db.contact[0].id,
      res.conversationId,
      "telegram",
      "hello",
    );
    expect(events.emit).toHaveBeenCalledWith(
      WORKFLOW_TRIGGER_EVENT,
      expect.objectContaining({ triggerType: "message_received" }),
    );
  });

  it("deduplicates on providerMessageId", async () => {
    const { prisma, svc, pipeline } = build();
    const first = await svc.record(input());
    const again = await svc.record(input());
    expect(again).toEqual({ conversationId: first.conversationId, messageId: first.messageId, duplicate: true });
    expect(prisma.db.message).toHaveLength(1);
    expect(pipeline.onInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("reuses the channel conversation and keeps the attachment", async () => {
    const { prisma, svc } = build();
    await svc.record(input());
    await svc.record(input({ providerMessageId: "tg:T:2", text: "[photo]", attachMediaId: "media-1" }));
    expect(prisma.db.conversation).toHaveLength(1);
    expect(prisma.db.conversation[0].unread).toBe(2);
    expect(prisma.db.message[1].attach).toBe("media-1");
  });
});
