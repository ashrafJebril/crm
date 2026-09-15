// backend/src/workflows/executors/update-data.executor.spec.ts
import { UpdateDataExecutor } from "./update-data.executor";

describe("UpdateDataExecutor", () => {
  let contacts: { get: jest.Mock; update: jest.Mock };
  let tickets: { moveTicket: jest.Mock };
  let executor: UpdateDataExecutor;

  beforeEach(() => {
    contacts = {
      get: jest.fn().mockResolvedValue({ id: "c1", tags: ["vip"] }),
      update: jest.fn().mockResolvedValue({ id: "c1" }),
    };
    tickets = { moveTicket: jest.fn().mockResolvedValue({ id: "t1", stageId: "st2" }) };
    executor = new UpdateDataExecutor(contacts as never, tickets as never);
  });

  const context = (extra: Record<string, unknown>) => ({ trigger: extra, steps: {} });

  it("adds a tag without duplicating an existing one", async () => {
    await executor.execute("ws1", { operation: "add_tag", tag: "vip" }, context({ contact: { id: "c1" } }));
    expect(contacts.update).toHaveBeenCalledWith("ws1", "c1", { tags: ["vip"] });
  });

  it("adds a new tag", async () => {
    await executor.execute("ws1", { operation: "add_tag", tag: "hot" }, context({ contact: { id: "c1" } }));
    expect(contacts.update).toHaveBeenCalledWith("ws1", "c1", { tags: ["vip", "hot"] });
  });

  it("removes a tag", async () => {
    await executor.execute("ws1", { operation: "remove_tag", tag: "vip" }, context({ contact: { id: "c1" } }));
    expect(contacts.update).toHaveBeenCalledWith("ws1", "c1", { tags: [] });
  });

  it("moves a ticket's stage", async () => {
    const result = await executor.execute(
      "ws1",
      { operation: "move_ticket_stage", stageId: "st2" },
      context({ ticket: { id: "t1" } }),
    );
    expect(tickets.moveTicket).toHaveBeenCalledWith("ws1", "t1", { stageId: "st2" });
    expect(result).toEqual({ stageId: "st2" });
  });

  it("updates a contact field", async () => {
    await executor.execute(
      "ws1",
      { operation: "update_contact_field", field: "lifecycle", value: "customer" },
      context({ contact: { id: "c1" } }),
    );
    expect(contacts.update).toHaveBeenCalledWith("ws1", "c1", { lifecycle: "customer" });
  });

  it("throws when a contact operation has no contact in context", async () => {
    await expect(executor.execute("ws1", { operation: "add_tag", tag: "vip" }, context({}))).rejects.toThrow(
      /contact/,
    );
  });

  it("throws when move_ticket_stage has no ticket in context", async () => {
    await expect(
      executor.execute("ws1", { operation: "move_ticket_stage", stageId: "st2" }, context({})),
    ).rejects.toThrow(/ticket/);
  });
});
