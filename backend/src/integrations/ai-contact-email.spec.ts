import { BadRequestException } from "@nestjs/common";
import { AiBridgeService } from "./ai-bridge.service";
import { AiReplyController } from "./ai-reply.controller";

const baseReply = {
  workspaceId: "ws-1",
  conversationId: "conv-1",
  body: "Your booking is confirmed",
  send: false,
};

function controller(contactId = "contact-1") {
  const prisma = {
    conversation: {
      findFirst: jest.fn(async () => ({
        id: "conv-1",
        contactId,
        aiEnabled: true,
        aiPausedAt: null,
        channel: "whatsapp",
      })),
    },
    contact: { updateMany: jest.fn(async () => ({ count: 1 })) },
    message: { create: jest.fn(async () => ({})) },
  } as any;
  const ctrl = new AiReplyController(
    prisma,
    {} as any,
    { verifyInboundSignature: jest.fn(() => true) } as any,
    { emitToWorkspace: jest.fn() } as any,
    {} as any,
    {} as any,
  );
  return { ctrl, prisma };
}

const requestFor = (body: unknown) => ({ rawBody: Buffer.from(JSON.stringify(body)) }) as never;

describe("AI contact email plumbing", () => {
  it("includes a persisted contactEmail in the signed AI inbound payload", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_WEBHOOK_SECRET = "secret";
    const fetchSpy = jest.fn(async () => ({ ok: true })) as any;
    const previousFetch = global.fetch;
    global.fetch = fetchSpy;
    try {
      await new AiBridgeService().notifyInbound({
        workspaceId: "ws-1",
        conversationId: "conv-1",
        contactId: "contact-1",
        channel: "whatsapp",
        messageId: "message-1",
        body: "hello",
        contactName: "Sara",
        contactPhone: "+962790000000",
        contactEmail: "sara@example.com",
        windowOpen: true,
        receivedAt: "2026-09-01T10:00:00.000Z",
      });
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
        contactEmail: "sara@example.com",
      });
    } finally {
      global.fetch = previousFetch;
      delete process.env.KEWY_AI_URL;
      delete process.env.KEWY_AI_WEBHOOK_SECRET;
    }
  });

  it("updates only the authenticated conversation's own contact", async () => {
    const { ctrl, prisma } = controller();
    const dto = { ...baseReply, capturedContactEmail: "  SARA@example.com  " };
    await ctrl.reply(requestFor(dto), "valid", dto as never);
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "contact-1", workspaceId: "ws-1" },
      data: { email: "sara@example.com" },
    });
  });

  it("rejects malformed captured email without updating any contact", async () => {
    const { ctrl, prisma } = controller();
    const dto = { ...baseReply, capturedContactEmail: "not an email" };
    await expect(ctrl.reply(requestFor(dto), "valid", dto as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it("refuses the callback when the conversation contact is not in that workspace", async () => {
    const { ctrl, prisma } = controller();
    prisma.contact.updateMany.mockResolvedValue({ count: 0 });
    const dto = { ...baseReply, capturedContactEmail: "sara@example.com" };
    await expect(ctrl.reply(requestFor(dto), "valid", dto as never)).rejects.toThrow(
      "Conversation contact not found",
    );
    expect(prisma.message.create).not.toHaveBeenCalled();
  });
});
