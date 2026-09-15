import { SendWhatsappExecutor } from "./send-whatsapp.executor";

describe("SendWhatsappExecutor", () => {
  let zernio: { sendInDbConversation: jest.Mock };
  let executor: SendWhatsappExecutor;

  beforeEach(() => {
    zernio = { sendInDbConversation: jest.fn().mockResolvedValue({ ok: true, id: "m1" }) };
    executor = new SendWhatsappExecutor(zernio as never);
  });

  it("resolves variables and sends via the conversation in the trigger payload", async () => {
    const context = { trigger: { contact: { name: "Sara" }, conversation: { id: "conv1" } }, steps: {} };
    const result = await executor.execute("ws1", { message: "Hi {{trigger.contact.name}}" }, context);
    expect(zernio.sendInDbConversation).toHaveBeenCalledWith("ws1", "conv1", "Hi Sara");
    expect(result).toEqual({ ok: true, id: "m1" });
  });

  it("falls back to the ticket's conversationId when there is no trigger.conversation", async () => {
    const context = { trigger: { ticket: { conversationId: "conv2" } }, steps: {} };
    await executor.execute("ws1", { message: "hi" }, context);
    expect(zernio.sendInDbConversation).toHaveBeenCalledWith("ws1", "conv2", "hi");
  });

  it("throws when no conversation can be resolved", async () => {
    const context = { trigger: { contact: { name: "Sara" } }, steps: {} };
    await expect(executor.execute("ws1", { message: "hi" }, context)).rejects.toThrow(/conversation/);
  });
});
