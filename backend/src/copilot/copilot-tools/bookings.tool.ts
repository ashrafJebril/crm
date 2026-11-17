import { z } from "zod";
import type { CopilotTool, ToolContext } from "./registry";
import { notFound, openRecord, type ReadToolDeps } from "./deps";

/**
 * SP-18 bookings: search (BookingsService's search, the same one the `@`
 * picker uses) or a date range, and one booking (RecordsService).
 */
export function bookingTools(deps: ReadToolDeps): CopilotTool[] {
  return [
    {
      name: "search_bookings",
      description:
        "Find bookings by the customer's name or phone or the service name, or list bookings in a date range (ISO 8601 with an offset), optionally by status.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        status: z.enum(["confirmed", "pending", "completed", "cancelled", "no-show"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      kind: "read",
      permissions: ["bookings.view"],
      label: ["Reading bookings", "قراءة الحجوزات"],
      async execute(ctx: ToolContext, input: { query?: string; from?: string; to?: string; status?: string; limit?: number }) {
        const limit = input.limit ?? 20;
        if (input.query && input.query.length >= 2) {
          const res = await deps.bookings.search(ctx.workspaceId, input.query, ctx.now);
          return { bookings: res.items.slice(0, limit) };
        }
        const where: Record<string, unknown> = { workspaceId: ctx.workspaceId };
        const range: Record<string, Date> = {};
        if (input.from) range.gte = new Date(input.from);
        if (input.to) range.lte = new Date(input.to);
        if (Object.keys(range).length) where.startAt = range;
        else where.startAt = { gte: ctx.now };
        if (input.status) where.status = input.status;
        const rows = await deps.prisma.appointment.findMany({
          where,
          orderBy: { startAt: "asc" },
          take: limit,
          select: { id: true, service: true, serviceAr: true, startAt: true, durationMin: true, status: true, contact: { select: { id: true, name: true } } },
        });
        return {
          bookings: rows.map((r) => ({
            id: r.id,
            service: r.service,
            serviceAr: r.serviceAr,
            startAt: r.startAt.toISOString(),
            durationMin: r.durationMin,
            status: r.status,
            customer: r.contact ? { id: r.contact.id, name: r.contact.name } : null,
          })),
        };
      },
    },
    {
      name: "get_booking",
      description: "Open one booking by id.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      kind: "read",
      permissions: ["bookings.view"],
      label: ["Reading a booking", "قراءة حجز"],
      async execute(ctx: ToolContext, input: { id: string }) {
        return (await openRecord(deps, ctx, "booking", input.id)) ?? notFound("booking");
      },
    },
  ];
}
