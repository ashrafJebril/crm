import { NotFoundException } from "@nestjs/common";
import { McpToolsFactory } from "./mcp-tools.factory";
import { AppointmentsService } from "../appointments/appointments.service";
import { ContactsService } from "../contacts/contacts.service";

describe("McpToolsFactory", () => {
  let appointments: { list: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let contacts: { search: jest.Mock; get: jest.Mock; create: jest.Mock; update: jest.Mock };
  let factory: McpToolsFactory;

  beforeEach(() => {
    appointments = { list: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    contacts = { search: jest.fn(), get: jest.fn(), create: jest.fn(), update: jest.fn() };
    factory = new McpToolsFactory(
      appointments as unknown as AppointmentsService,
      contacts as unknown as ContactsService,
    );
  });

  const tools = (workspaceId = "ws1") => factory.build(workspaceId);

  it("exposes exactly the nine expected tools and no delete tool", () => {
    expect(Object.keys(tools()).sort()).toEqual([
      "cancel_appointment", "create_appointment", "create_contact", "get_appointment",
      "get_contact", "list_appointments", "search_contacts", "update_appointment", "update_contact",
    ]);
  });

  it("list_appointments scopes to the workspace and forwards filters", async () => {
    appointments.list.mockResolvedValue([{ id: "a1" }]);
    const result = await tools("ws1").list_appointments.execute!({ status: "confirmed" }, {} as never);
    expect(appointments.list).toHaveBeenCalledWith("ws1", { status: "confirmed" });
    expect(result).toEqual([{ id: "a1" }]);
  });

  it("get_appointment converts a Nest NotFoundException into a plain Error", async () => {
    appointments.get.mockRejectedValue(new NotFoundException("Appointment not found"));
    await expect(tools("ws1").get_appointment.execute!({ id: "missing" }, {} as never)).rejects.toThrow(
      "Appointment not found",
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
    expect(appointments.list).toHaveBeenNthCalledWith(1, "ws-a", {});
    expect(appointments.list).toHaveBeenNthCalledWith(2, "ws-b", {});
  });
});
