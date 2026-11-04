import { SendWhatsappTemplateExecutor } from "./send-whatsapp-template.executor";

describe("SendWhatsappTemplateExecutor", () => {
  let prisma: { conversation: { findFirst: jest.Mock }; integration: { findFirst: jest.Mock } };
  let zernio: { sendTemplateInDbConversation: jest.Mock };
  let meta: { sendTemplateInConversation: jest.Mock };
  let executor: SendWhatsappTemplateExecutor;

  const config = { name: "receipt", language: "en", variables: ["{{trigger.contact.name}}", "{{trigger.sale.itemsText}}"] };

  beforeEach(() => {
    prisma = {
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: "conv-latest" }) },
      integration: { findFirst: jest.fn().mockResolvedValue({ provider: "zernio" }) },
    };
    zernio = { sendTemplateInDbConversation: jest.fn().mockResolvedValue({ ok: true, id: "z1" }) };
    meta = { sendTemplateInConversation: jest.fn().mockResolvedValue({ ok: true, wamid: "w1" }) };
    executor = new SendWhatsappTemplateExecutor(prisma as never, zernio as never, meta as never);
  });

  it("fills variables and sends into the trigger's conversation via Zernio", async () => {
    const context = {
      trigger: { contact: { id: "c1", name: "Lina" }, conversation: { id: "conv1", channel: "whatsapp" }, sale: { itemsText: "Cut ×1" } },
      steps: {},
    };
    const result = await executor.execute("ws1", config, context);
    expect(zernio.sendTemplateInDbConversation).toHaveBeenCalledWith("ws1", "conv1", "receipt", "en", ["Lina", "Cut ×1"]);
    expect(result).toEqual({ ok: true, id: "z1", conversationId: "conv1" });
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
  });

  it("flattens line breaks, which Meta rejects inside template variables", async () => {
    const context = {
      trigger: { contact: { id: "c1", name: "Lina" }, conversation: { id: "conv1", channel: "whatsapp" }, sale: { itemsText: "Cut\n\nBeard\tTrim" } },
      steps: {},
    };
    await executor.execute("ws1", config, context);
    expect(zernio.sendTemplateInDbConversation.mock.calls[0][4]).toEqual(["Lina", "Cut · Beard Trim"]);
  });

  it("ignores a non-WhatsApp trigger conversation and uses the contact's WhatsApp chat", async () => {
    const context = { trigger: { contact: { id: "c1", name: "Lina" }, conversation: { id: "ig1", channel: "instagram" } }, steps: {} };
    await executor.execute("ws1", { ...config, variables: [] }, context);
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws1", contactId: "c1", channel: "whatsapp" } }),
    );
    expect(zernio.sendTemplateInDbConversation).toHaveBeenCalledWith("ws1", "conv-latest", "receipt", "en", []);
  });

  it("finds the contact from a ticket or appointment payload", async () => {
    await executor.execute("ws1", { ...config, variables: [] }, { trigger: { appointment: { contactId: "c9" } }, steps: {} });
    expect(prisma.conversation.findFirst.mock.calls[0][0].where.contactId).toBe("c9");
  });

  it("uses the ticket's own conversation when there is one", async () => {
    await executor.execute("ws1", { ...config, variables: [] }, { trigger: { ticket: { conversationId: "t-conv", contactId: "c1" } }, steps: {} });
    expect(zernio.sendTemplateInDbConversation.mock.calls[0][1]).toBe("t-conv");
  });

  it("sends through the Meta connection when WhatsApp isn't on Zernio", async () => {
    prisma.integration.findFirst.mockResolvedValue({ provider: "meta" });
    const context = { trigger: { conversation: { id: "conv1", channel: "whatsapp" } }, steps: {} };
    const result = await executor.execute("ws1", { ...config, variables: [] }, context);
    expect(meta.sendTemplateInConversation).toHaveBeenCalledWith("ws1", "conv1", "receipt", "en", []);
    expect(zernio.sendTemplateInDbConversation).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, id: "w1", conversationId: "conv1" });
  });

  it("explains what's wrong when the customer has no WhatsApp chat yet", async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    const context = { trigger: { contact: { id: "c1", name: "Lina" } }, steps: {} };
    await expect(executor.execute("ws1", config, context)).rejects.toThrow(/no WhatsApp chat/i);
  });

  it("fails clearly when WhatsApp isn't connected", async () => {
    prisma.integration.findFirst.mockResolvedValue(null);
    const context = { trigger: { conversation: { id: "conv1", channel: "whatsapp" } }, steps: {} };
    await expect(executor.execute("ws1", config, context)).rejects.toThrow(/not connected/i);
  });
});
