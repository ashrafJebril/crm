import { applyConversationAssignment } from "./assign-conversation";

function make(opts: { count?: number; member?: boolean } = {}) {
  const updatedAt = new Date(5);
  const prisma: any = {
    workspaceMember: { findFirst: jest.fn().mockResolvedValue(opts.member === false ? null : { id: "m" }) },
    conversation: {
      findFirst: jest.fn().mockResolvedValue({ id: "cv", channel: "whatsapp", contactId: "c1", assigneeId: null, updatedAt, version: 2, labels: [] }),
      updateMany: jest.fn().mockResolvedValue({ count: opts.count ?? 1 }),
    },
    contact: { findFirst: jest.fn().mockResolvedValue({ name: "Sara" }) },
    user: { findUnique: jest.fn().mockResolvedValue({ name: "Boss" }) },
  };
  const realtime = { emitToWorkspace: jest.fn() };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  return { prisma, realtime, notifications, deps: { prisma, realtime, notifications } as any, updatedAt };
}

describe("applyConversationAssignment", () => {
  it("guarded update with version bump, preserved updatedAt, inbox.activity and notification", async () => {
    const m = make();
    const r = await applyConversationAssignment(m.deps, {
      workspaceId: "ws", conversationId: "cv", assigneeId: "u2", actorId: "u1",
      extraData: { pinned: true }, enforceVersion: 2, preserveUpdatedAt: true,
      current: { assigneeId: null, updatedAt: m.updatedAt, version: 2 },
    });
    expect(r.count).toBe(1);
    expect(m.prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "cv", workspaceId: "ws", version: 2 },
      data: { pinned: true, assigneeId: "u2", version: { increment: 1 }, updatedAt: m.updatedAt },
    });
    expect(m.realtime.emitToWorkspace).toHaveBeenCalledWith("ws", "inbox.activity", { channel: "whatsapp", conversationId: "cv" });
    expect(m.notifications.notify).toHaveBeenCalledWith("ws", ["u2"], expect.objectContaining({ title: "assignment.conversation", recordId: "cv" }));
  });

  it("a lost version guard emits and notifies nothing", async () => {
    const m = make({ count: 0 });
    const r = await applyConversationAssignment(m.deps, { workspaceId: "ws", conversationId: "cv", assigneeId: "u2", enforceVersion: 1, preserveUpdatedAt: true });
    expect(r.count).toBe(0);
    expect(m.realtime.emitToWorkspace).not.toHaveBeenCalled();
    expect(m.notifications.notify).not.toHaveBeenCalled();
  });

  it("does not notify the actor or an unchanged assignee", async () => {
    const m = make();
    await applyConversationAssignment(m.deps, { workspaceId: "ws", conversationId: "cv", assigneeId: "u1", actorId: "u1", preserveUpdatedAt: true });
    expect(m.notifications.notify).not.toHaveBeenCalled();
  });

  it("requireMember skips a non-member assignee without writing", async () => {
    const m = make({ member: false });
    const r = await applyConversationAssignment(m.deps, { workspaceId: "ws", conversationId: "cv", assigneeId: "x", preserveUpdatedAt: true, requireMember: true });
    expect(r.count).toBe(0);
    expect(m.prisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("a notification failure never fails the assignment", async () => {
    const m = make();
    m.notifications.notify.mockRejectedValue(new Error("boom"));
    await expect(applyConversationAssignment(m.deps, { workspaceId: "ws", conversationId: "cv", assigneeId: "u2", actorId: "u1", preserveUpdatedAt: true })).resolves.toMatchObject({ count: 1 });
  });
});
