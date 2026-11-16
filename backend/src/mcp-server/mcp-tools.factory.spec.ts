import { NotFoundException } from "@nestjs/common";
import { McpToolsFactory } from "./mcp-tools.factory";
import { AppointmentsService } from "../appointments/appointments.service";
import { ContactsService } from "../contacts/contacts.service";
import { MediaService } from "../media/media.service";
import { BookingsService } from "../bookings/bookings.service";
import { bookingError } from "../bookings/booking-errors";

describe("McpToolsFactory", () => {
  let appointments: { list: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let contacts: { search: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let media: { listForAgent: jest.Mock };
  let bookings: { activeServices: jest.Mock; availability: jest.Mock };
  let factory: McpToolsFactory;

  beforeEach(() => {
    appointments = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    contacts = { search: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    media = { listForAgent: jest.fn() };
    bookings = { activeServices: jest.fn(), availability: jest.fn() };
    factory = new McpToolsFactory(
      appointments as unknown as AppointmentsService,
      contacts as unknown as ContactsService,
      media as unknown as MediaService,
      bookings as unknown as BookingsService,
    );
  });

  const tools = (workspaceId = "ws1") => factory.build(workspaceId);

  it("exposes exactly the twelve expected tools and no delete tool (SP-17 list_photos, SP-10 list_services and find_slots)", () => {
    expect(Object.keys(tools()).sort()).toEqual([
      "cancel_appointment", "create_appointment", "create_contact", "find_slots", "get_appointment",
      "get_contact", "list_appointments", "list_photos", "list_services", "search_contacts", "update_appointment",
      "update_contact",
    ]);
  });

  it("SP-10: list_services and find_slots scope to the workspace", async () => {
    bookings.activeServices.mockResolvedValue([{ id: "s1" }]);
    bookings.availability.mockResolvedValue({ slots: [] });
    expect(await tools("ws1").list_services.execute!({}, {} as never)).toEqual([{ id: "s1" }]);
    expect(bookings.activeServices).toHaveBeenCalledWith("ws1");
    await tools("ws1").find_slots.execute!({ serviceId: "s1", date: "2026-11-17" }, {} as never);
    expect(bookings.availability).toHaveBeenCalledWith("ws1", { serviceId: "s1", date: "2026-11-17" });
  });

  it("SP-10: a booking error reaches the agent as its key plus its details (no internals)", async () => {
    appointments.update.mockRejectedValue(
      bookingError("bookings.illegal_transition", { from: "completed", to: "pending", allowed: [] }),
    );
    await expect(tools("ws1").update_appointment.execute!({ id: "a1", status: "pending" }, {} as never)).rejects.toThrow(
      'bookings.illegal_transition {"from":"completed","to":"pending","allowed":[]}',
    );
  });

  it("list_appointments scopes to the workspace and forwards filters", async () => {
    appointments.list.mockResolvedValue([{ id: "a1" }]);
    const result = await tools("ws1").list_appointments.execute!({ status: "confirmed" }, {} as never);
    expect(appointments.list).toHaveBeenCalledWith("ws1", { status: "confirmed", limit: 50 });
    expect(result).toEqual([{ id: "a1" }]);
  });

  it("get_appointment converts a Nest NotFoundException into a plain Error", async () => {
    appointments.get.mockRejectedValue(new NotFoundException("Appointment not found"));
    await expect(tools("ws1").get_appointment.execute!({ id: "missing" }, {} as never)).rejects.toThrow(
      "Appointment not found",
    );
  });

  it("converts a non-HttpException error (e.g. a Prisma error) to a generic message, not leaking internals", async () => {
    appointments.get.mockRejectedValue(
      new Error(
        'Invalid `prisma.appointment.findFirst()` invocation: table "Appointment" column "secret_internal_col" ...',
      ),
    );
    await expect(tools("ws1").get_appointment.execute!({ id: "x" }, {} as never)).rejects.toThrow(
      "Unexpected error",
    );
  });

  it("create_appointment forwards the full dto to the service", async () => {
    appointments.create.mockResolvedValue({ id: "a2" });
    const input = {
      contactId: "c1", service: "Cut", serviceAr: "قص", startAt: "2026-09-20T10:00:00.000Z",
      durationMin: 30, status: "pending" as const, source: "human" as const,
    };
    await tools("ws1").create_appointment.execute!(input, {} as never);
    expect(appointments.create).toHaveBeenCalledWith("ws1", input);
  });

  it("update_appointment strips id from the update payload", async () => {
    appointments.update.mockResolvedValue({ id: "a1" });
    await tools("ws1").update_appointment.execute!({ id: "a1", status: "completed" }, {} as never);
    expect(appointments.update).toHaveBeenCalledWith("ws1", "a1", { status: "completed" });
  });

  it("cancel_appointment sets status to cancelled via update(), never a remove()", async () => {
    appointments.update.mockResolvedValue({ id: "a1", status: "cancelled" });
    await tools("ws1").cancel_appointment.execute!({ id: "a1" }, {} as never);
    expect(appointments.update).toHaveBeenCalledWith("ws1", "a1", { status: "cancelled" });
    expect((appointments as Record<string, unknown>).remove).toBeUndefined();
  });

  it("search_contacts scopes to the workspace", async () => {
    contacts.search.mockResolvedValue([{ id: "c1" }]);
    const result = await tools("ws1").search_contacts.execute!({ query: "sara" }, {} as never);
    expect(contacts.search).toHaveBeenCalledWith("ws1", "sara");
    expect(result).toEqual([{ id: "c1" }]);
  });

  it("create_contact forwards the dto", async () => {
    contacts.create.mockResolvedValue({ id: "c2" });
    const input = { name: "Sara", industry: "retail", lifecycle: "lead", source: "wa" };
    await tools("ws1").create_contact.execute!(input, {} as never);
    expect(contacts.create).toHaveBeenCalledWith("ws1", input);
  });

  it("update_contact strips id from the update payload", async () => {
    contacts.update.mockResolvedValue({ id: "c1" });
    await tools("ws1").update_contact.execute!({ id: "c1", lifecycle: "customer" }, {} as never);
    expect(contacts.update).toHaveBeenCalledWith("ws1", "c1", { lifecycle: "customer" });
  });

  it("two different workspaceIds produce independently-scoped tool sets", async () => {
    appointments.list.mockResolvedValue([]);
    await tools("ws-a").list_appointments.execute!({}, {} as never);
    await tools("ws-b").list_appointments.execute!({}, {} as never);
    expect(appointments.list).toHaveBeenNthCalledWith(1, "ws-a", { limit: 50 });
    expect(appointments.list).toHaveBeenNthCalledWith(2, "ws-b", { limit: 50 });
  });
});
