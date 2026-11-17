/* eslint-disable @typescript-eslint/no-explicit-any */
import { applyConversationAssignment } from "../conversations/assign-conversation";
import { bookingWorld, legacyInput, A } from "../bookings/booking-test-world";
import { WEBHOOK_EVENT } from "./webhook-events";

/** SP-27 ruling 4: the two new emits, both after their write committed. */
describe("webhook emits", () => {
  it("booking.created is emitted after the booking row exists", async () => {
    const order: string[] = [];
    const events = {
      emit: jest.fn((name: string, e: any) => {
        if (name === WEBHOOK_EVENT) order.push(`${e.type}:${w.prisma.db.appointment.some((a: any) => a.id === e.entityId)}`);
        return true;
      }),
    };
    const w: any = await bookingWorld({ events });
    const created = await w.appointments.create(A, legacyInput({ staffId: "uAgent" }));
    const hook = events.emit.mock.calls.filter((c) => c[0] === WEBHOOK_EVENT);
    expect(hook).toEqual([[WEBHOOK_EVENT, { workspaceId: A, type: "booking.created", entityId: created.id }]]);
    expect(order).toEqual(["booking.created:true"]);
  });

  it("booking.created is not emitted when the create is refused", async () => {
    const events = { emit: jest.fn() };
    const w: any = await bookingWorld({ events });
    await w.appointments.create(A, legacyInput({ contactId: "missing" })).catch(() => null);
    expect(events.emit.mock.calls.filter((c) => c[0] === WEBHOOK_EVENT)).toEqual([]);
  });

  it("conversation.assigned on a change of assignee only, keyed by the new version", async () => {
    const make = (count = 1, before: string | null = null) => {
      const prisma: any = {
        workspaceMember: { findFirst: jest.fn().mockResolvedValue({ id: "m" }) },
        conversation: {
          findFirst: jest.fn().mockResolvedValue({ id: "cv", channel: "whatsapp", contactId: "c1", assigneeId: "u2", version: 3, labels: [] }),
          updateMany: jest.fn().mockResolvedValue({ count }),
        },
        contact: { findFirst: jest.fn().mockResolvedValue({ name: "Sara" }) },
        user: { findUnique: jest.fn().mockResolvedValue({ name: "Boss" }) },
      };
      const events = { emit: jest.fn() };
      const deps = { prisma, realtime: { emitToWorkspace: jest.fn() }, events } as any;
      const run = () =>
        applyConversationAssignment(deps, {
          workspaceId: "ws",
          conversationId: "cv",
          assigneeId: "u2",
          actorId: "u2",
          preserveUpdatedAt: true,
          current: { assigneeId: before, updatedAt: new Date(5), version: 2 },
        });
      return { events, run };
    };
    const a = make();
    await a.run();
    // Self-assignment still counts (no notification, but the webhook fires).
    expect(a.events.emit).toHaveBeenCalledWith(WEBHOOK_EVENT, {
      workspaceId: "ws",
      type: "conversation.assigned",
      entityId: "cv",
      occurrence: "cv:3",
    });
    const unchanged = make(1, "u2");
    await unchanged.run();
    expect(unchanged.events.emit).not.toHaveBeenCalled();
    const lost = make(0);
    await lost.run();
    expect(lost.events.emit).not.toHaveBeenCalled();
  });
});
