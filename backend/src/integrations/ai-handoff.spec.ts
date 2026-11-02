import { AiHandoffService } from "./ai-handoff.service";
import { WhatsAppController } from "./whatsapp.controller";
import { ZernioController } from "./zernio.controller";
import { InstagramController } from "./instagram.controller";

describe("AI hand-off when staff reply", () => {
  let prisma: any;
  let handoff: AiHandoffService;

  beforeEach(() => {
    prisma = { conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    handoff = new AiHandoffService(prisma as never);
  });

  const paused = () =>
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv-1", workspaceId: "ws-1" },
      data: { aiPausedAt: expect.any(Date) },
    });

  it("a WhatsApp reply and template from the Inbox pause the AI", async () => {
    const wa = { sendInConversation: jest.fn().mockResolvedValue({ wamid: "x" }), sendTemplateInConversation: jest.fn().mockResolvedValue({}) };
    const c = new WhatsAppController(wa as never, handoff);
    await c.sendInConversation("ws-1", "conv-1", { message: "hi" } as never);
    paused();
    prisma.conversation.updateMany.mockClear();
    await c.sendTemplateInConversation("ws-1", "conv-1", { name: "t", language: "ar" } as never);
    paused();
  });

  it("a Zernio (WhatsApp/IG/FB) reply and template from the Inbox pause the AI", async () => {
    const zernio = { sendInDbConversation: jest.fn().mockResolvedValue({ ok: true }), sendTemplateInDbConversation: jest.fn().mockResolvedValue({ ok: true }) };
    const c = new ZernioController(zernio as never, handoff);
    await c.sendInDbConversation("ws-1", "conv-1", { message: "hi" } as never);
    paused();
    prisma.conversation.updateMany.mockClear();
    await c.sendTemplateInDbConversation("ws-1", "conv-1", { name: "t", language: "ar" } as never);
    paused();
  });

  it("an Instagram reply from the Inbox pauses the AI", async () => {
    const ig = { sendInConversation: jest.fn().mockResolvedValue({ ok: true }) };
    await new InstagramController(ig as never, handoff).send("ws-1", "conv-1", { message: "hi" });
    paused();
  });

  it("a send that fails does not pause the AI", async () => {
    const wa = { sendInConversation: jest.fn().mockRejectedValue(new Error("outside 24h window")) };
    await expect(new WhatsAppController(wa as never, handoff).sendInConversation("ws-1", "conv-1", { message: "hi" } as never)).rejects.toThrow();
    expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("only touches the conversation in the caller's workspace", async () => {
    await handoff.humanReplied("ws-1", "conv-1");
    expect(prisma.conversation.updateMany.mock.calls[0][0].where).toEqual({ id: "conv-1", workspaceId: "ws-1" });
  });
});
