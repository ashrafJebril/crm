import { AskAgentExecutor } from "./ask-agent.executor";

describe("AskAgentExecutor", () => {
  let lAgent: { ask: jest.Mock };
  let executor: AskAgentExecutor;

  beforeEach(() => {
    lAgent = { ask: jest.fn().mockResolvedValue({ answer: "Yes, they qualify" }) };
    executor = new AskAgentExecutor(lAgent as never);
  });

  it("resolves variables in the prompt and asks via the conversation id", async () => {
    const context = { trigger: { conversation: { id: "conv1" } }, steps: {} };
    const result = await executor.execute("ws1", { prompt: "Evaluate {{trigger.conversation.id}}" }, context);
    expect(lAgent.ask).toHaveBeenCalledWith("ws1", {
      externalId: "conv1",
      message: "Evaluate conv1",
    });
    expect(result).toEqual({ answer: "Yes, they qualify" });
  });

  it("falls back to the ticket's conversationId", async () => {
    const context = { trigger: { ticket: { conversationId: "conv2" } }, steps: {} };
    await executor.execute("ws1", { prompt: "hi" }, context);
    expect(lAgent.ask).toHaveBeenCalledWith("ws1", { externalId: "conv2", message: "hi" });
  });

  it("falls back to a synthetic id keyed on the contact", async () => {
    const context = { trigger: { contact: { id: "c1" } }, steps: {} };
    await executor.execute("ws1", { prompt: "hi" }, context);
    expect(lAgent.ask).toHaveBeenCalledWith("ws1", { externalId: "workflow-c1", message: "hi" });
  });

  it("throws when nothing identifies a conversation or contact", async () => {
    const context = { trigger: {}, steps: {} };
    await expect(executor.execute("ws1", { prompt: "hi" }, context)).rejects.toThrow(/conversation or contact/);
  });
});
