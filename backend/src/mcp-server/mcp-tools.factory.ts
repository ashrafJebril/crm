import { HttpException, Injectable } from "@nestjs/common";
import { createTool, type Tool } from "@mastra/core/tools";
import { z } from "zod";
import { AppointmentsService } from "../appointments/appointments.service";
import { ContactsService } from "../contacts/contacts.service";

const APPOINTMENT_STATUSES = ["confirmed", "pending", "completed", "cancelled", "no-show"] as const;
const APPOINTMENT_SOURCES = ["human", "self-booking"] as const;

/**
 * Nest exceptions (e.g. NotFoundException) carry framework-specific shape
 * that shouldn't leak into a tool's MCP error text. Re-throwing a plain
 * Error keeps the message but drops everything else; the MCP transport
 * catches it and reports isError:true with this message as the content.
 */
async function unwrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) {
      throw new Error(err.message);
    }
    throw new Error("Unexpected error");
  }
}

@Injectable()
export class McpToolsFactory {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly contacts: ContactsService,
  ) {}

  build(workspaceId: string): Record<string, Tool> {
    return {
      list_appointments: createTool({
        id: "list_appointments",
        description: "List appointments in this workspace, optionally filtered by date range or status.",
        inputSchema: z.object({
          from: z.string().datetime({ offset: true }).optional().describe("ISO 8601 start of range (inclusive)"),
          to: z.string().datetime({ offset: true }).optional().describe("ISO 8601 end of range (inclusive)"),
          status: z.enum(APPOINTMENT_STATUSES).optional(),
          limit: z.number().int().min(1).max(200).default(50).describe("Max rows to return (default 50, max 200)"),
        }),
        execute: (input) => unwrap(() => this.appointments.list(workspaceId, input)),
      }),

      get_appointment: createTool({
        id: "get_appointment",
        description: "Get a single appointment by id.",
        inputSchema: z.object({ id: z.string() }),
        execute: (input) => unwrap(() => this.appointments.get(workspaceId, input.id)),
      }),

      create_appointment: createTool({
        id: "create_appointment",
        description: "Create a new appointment for an existing contact.",
        inputSchema: z.object({
          contactId: z.string(),
          service: z.string(),
          serviceAr: z.string(),
          startAt: z.string().datetime({ offset: true }),
          durationMin: z.number().int().min(1),
          status: z.enum(APPOINTMENT_STATUSES),
          source: z.enum(APPOINTMENT_SOURCES),
          staffId: z.string().optional(),
          note: z.string().optional(),
          noteAr: z.string().optional(),
        }),
        execute: (input) => unwrap(() => this.appointments.create(workspaceId, input)),
      }),

      update_appointment: createTool({
        id: "update_appointment",
        description: "Update fields on an existing appointment.",
        inputSchema: z.object({
          id: z.string(),
          service: z.string().optional(),
          serviceAr: z.string().optional(),
          startAt: z.string().datetime({ offset: true }).optional(),
          durationMin: z.number().int().min(1).optional(),
          status: z.enum(APPOINTMENT_STATUSES).optional(),
          source: z.enum(APPOINTMENT_SOURCES).optional(),
          staffId: z.string().optional(),
          note: z.string().optional(),
          noteAr: z.string().optional(),
        }),
        execute: ({ id, ...dto }) => unwrap(() => this.appointments.update(workspaceId, id, dto)),
      }),

      cancel_appointment: createTool({
        id: "cancel_appointment",
        description: "Cancel an appointment (sets status to cancelled). Never permanently deletes it.",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => unwrap(() => this.appointments.update(workspaceId, id, { status: "cancelled" })),
      }),

      search_contacts: createTool({
        id: "search_contacts",
        description: "Search contacts in this workspace by name or phone.",
        inputSchema: z.object({ query: z.string().min(1) }),
        execute: ({ query }) => unwrap(() => this.contacts.search(workspaceId, query)),
      }),

      get_contact: createTool({
        id: "get_contact",
        description: "Get a single contact by id.",
        inputSchema: z.object({ id: z.string() }),
        execute: (input) => unwrap(() => this.contacts.get(workspaceId, input.id)),
      }),

      create_contact: createTool({
        id: "create_contact",
        description: "Create a new contact.",
        inputSchema: z.object({
          name: z.string(),
          phone: z.string().optional(),
          industry: z.string(),
          lifecycle: z.string(),
          source: z.string(),
          value: z.string().optional(),
          tags: z.array(z.string()).optional(),
        }),
        execute: (input) => unwrap(() => this.contacts.create(workspaceId, input)),
      }),

      update_contact: createTool({
        id: "update_contact",
        description: "Update fields on an existing contact.",
        inputSchema: z.object({
          id: z.string(),
          name: z.string().optional(),
          phone: z.string().optional(),
          industry: z.string().optional(),
          lifecycle: z.string().optional(),
          source: z.string().optional(),
          value: z.string().optional(),
          tags: z.array(z.string()).optional(),
        }),
        execute: ({ id, ...dto }) => unwrap(() => this.contacts.update(workspaceId, id, dto)),
      }),
    };
  }
}
