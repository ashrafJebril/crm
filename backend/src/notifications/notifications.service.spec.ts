import { NotFoundException } from "@nestjs/common";
import { NotificationsService } from "./notifications.service";

describe("NotificationsService", () => {
  let prisma: any;
  let realtime: { emitToUser: jest.Mock };
  let svc: NotificationsService;

  beforeEach(() => {
    prisma = {
      notificationPreference: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockImplementation((a) => Promise.resolve(a)),
      },
      notification: {
        createMany: jest.fn().mockImplementation(({ data }) => Promise.resolve({ count: data.length })),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    realtime = { emitToUser: jest.fn() };
    svc = new NotificationsService(prisma, realtime as never);
  });

  const n = { type: "assignment" as const, title: "assignment.conversation", body: '{"contactName":"محمد"}', recordKind: "conversation" as const, recordId: "cv1", actorId: "actor" };

  it("notify skips actor and duplicates", async () => {
    const count = await svc.notify("ws1", ["u1", "u1", "actor", "u2"], n);
    expect(count).toBe(2);
    const data = prisma.notification.createMany.mock.calls[0][0].data;
    expect(data.map((d: any) => d.userId)).toEqual(["u1", "u2"]);
    expect(data[0]).toMatchObject({ workspaceId: "ws1", type: "assignment", title: "assignment.conversation", actorId: "actor" });
  });

  it("notify returns 0 without touching the db when only the actor is targeted", async () => {
    expect(await svc.notify("ws1", ["actor"], n)).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("notify respects inApp=false", async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: "u1", inApp: false, sound: true }]);
    const count = await svc.notify("ws1", ["u1", "u2"], n);
    expect(count).toBe(1);
    const data = prisma.notification.createMany.mock.calls[0][0].data;
    expect(data.map((d: any) => d.userId)).toEqual(["u2"]);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(1);
    expect(realtime.emitToUser.mock.calls[0][1]).toBe("u2");
  });

  it("notify persists and emits nothing when every recipient opted out", async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: "u1", inApp: false, sound: true }]);
    expect(await svc.notify("ws1", ["u1"], n)).toBe(0);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it("notify emits to user room", async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: "u1", inApp: true, sound: false }]);
    await svc.notify("ws1", ["u1", "u2"], n);
    expect(realtime.emitToUser).toHaveBeenCalledTimes(2);
    const [ws, user, event, payload] = realtime.emitToUser.mock.calls[0];
    expect([ws, user, event]).toEqual(["ws1", "u1", "notification:new"]);
    expect(payload).toEqual({
      id: expect.any(String),
      type: "assignment",
      title: "assignment.conversation",
      body: '{"contactName":"محمد"}',
      recordKind: "conversation",
      recordId: "cv1",
      createdAt: expect.any(Date),
      sound: false,
    });
    expect(realtime.emitToUser.mock.calls[1][3].sound).toBe(true);
    // Emitted id matches the persisted row.
    const data = prisma.notification.createMany.mock.calls[0][0].data;
    expect(payload.id).toBe(data[0].id);
  });

  it("notify never throws", async () => {
    prisma.notification.createMany.mockRejectedValue(new Error("db down"));
    await expect(svc.notify("ws1", ["u1"], n)).resolves.toBe(0);
    prisma.notificationPreference.findMany.mockRejectedValue(new Error("db down"));
    await expect(svc.notify("ws1", ["u1"], n)).resolves.toBe(0);
    expect(realtime.emitToUser).not.toHaveBeenCalled();
  });

  it("list is cursor-paginated and user-scoped", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}` }));
    prisma.notification.findMany.mockResolvedValue(rows);
    const page = await svc.list("ws1", "u1");
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe("n19");
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: "ws1", userId: "u1" });
    expect(args.take).toBe(21);
    expect(args.cursor).toBeUndefined();

    prisma.notification.findMany.mockResolvedValue([{ id: "n20" }]);
    const last = await svc.list("ws1", "u1", "n19");
    expect(last).toEqual({ items: [{ id: "n20" }], nextCursor: null });
    const args2 = prisma.notification.findMany.mock.calls[1][0];
    expect(args2.cursor).toEqual({ id: "n19" });
    expect(args2.skip).toBe(1);
    expect(args2.where).toEqual({ workspaceId: "ws1", userId: "u1" });
  });

  it("unread count is a user-scoped count", async () => {
    prisma.notification.count.mockResolvedValue(4);
    expect(await svc.unreadCount("ws1", "u1")).toEqual({ count: 4 });
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", userId: "u1", readAt: null },
    });
  });

  it("read/mark another member's notification → 404", async () => {
    prisma.notification.findMany.mockResolvedValue([]); // none owned by u1
    await expect(svc.markRead("ws1", "u1", { ids: ["theirs"] })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notification.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws1", userId: "u1" });
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("read marks own ids and reports the updated count", async () => {
    prisma.notification.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    prisma.notification.updateMany.mockResolvedValue({ count: 2 });
    expect(await svc.markRead("ws1", "u1", { ids: ["a", "b", "a"] })).toEqual({ updated: 2 });
    expect(prisma.notification.updateMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: "ws1",
      userId: "u1",
      id: { in: ["a", "b"] },
    });
  });

  it("read all only touches mine", async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 5 });
    expect(await svc.markRead("ws1", "u1", { all: true })).toEqual({ updated: 5 });
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    const arg = prisma.notification.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "ws1", userId: "u1", readAt: null });
    expect(arg.data.readAt).toBeInstanceOf(Date);
  });

  it("preferences default on", async () => {
    prisma.notificationPreference.findMany.mockResolvedValue([{ type: "mention", inApp: false, sound: true }]);
    const prefs = await svc.getPreferences("ws1", "u1");
    expect(prefs).toHaveLength(7);
    expect(prefs.find((p) => p.type === "assignment")).toEqual({ type: "assignment", inApp: true, sound: true });
    expect(prefs.find((p) => p.type === "mention")).toEqual({ type: "mention", inApp: false, sound: true });
    expect(prisma.notificationPreference.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws1", userId: "u1" });
  });

  it("updatePreferences upserts each row for the current user", async () => {
    await svc.updatePreferences("ws1", "u1", { items: [{ type: "mention", inApp: false, sound: false }] });
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId_type: { workspaceId: "ws1", userId: "u1", type: "mention" } },
      create: { workspaceId: "ws1", userId: "u1", type: "mention", inApp: false, sound: false },
      update: { inApp: false, sound: false },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("updatePreferences dedupes by type, last wins", async () => {
    await svc.updatePreferences("ws1", "u1", {
      items: [
        { type: "mention", inApp: true, sound: true },
        { type: "mention", inApp: false, sound: false },
      ],
    });
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.notificationPreference.upsert.mock.calls[0][0].update).toEqual({ inApp: false, sound: false });
  });
});
