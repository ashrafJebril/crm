import { z } from "zod";
import type { ListTicketsQuery } from "../../tickets/tickets.dto";
import type { CopilotTool, ToolContext } from "./registry";
import { notFound, openRecord, visibleIds, type ReadToolDeps } from "./deps";

/** SP-18 tickets: the member's ticket list (TicketsService) filtered to what they can open, and one ticket (RecordsService). */
export function ticketTools(deps: ReadToolDeps): CopilotTool[] {
  return [
    {
      name: "search_tickets",
      description: "List tickets, optionally filtered by words, pipeline, stage or SLA state. Returns ids, titles, stages and owners.",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional(),
        pipelineId: z.string().max(64).optional(),
        stageId: z.string().max(64).optional(),
        sla: z.enum(["breached", "at_risk", "ok"]).optional(),
        status: z.enum(["open", "won", "lost"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      kind: "read",
      permissions: ["tickets.view"],
      label: ["Reading tickets", "قراءة التذاكر"],
      async execute(ctx: ToolContext, input: { query?: string; pipelineId?: string; stageId?: string; sla?: string; status?: "open" | "won" | "lost"; limit?: number }) {
        const q = { q: input.query, pipelineId: input.pipelineId, stageId: input.stageId, status: input.status, sla: input.sla, limit: input.limit ?? 20 } as unknown as ListTicketsQuery;
        const res = (await deps.tickets.listTickets(ctx.workspaceId, q, ctx.viewer)) as unknown;
        const rows = (Array.isArray(res) ? res : ((res as { items?: unknown[] }).items ?? [])) as Array<Record<string, unknown>>;
        const ok = await visibleIds(deps, ctx, "ticket", rows.map((r) => String(r.id)));
        return {
          tickets: rows
            .filter((r) => ok.has(String(r.id)))
            .slice(0, input.limit ?? 20)
            .map((r) => ({
              id: r.id,
              number: r.number,
              title: r.title,
              stage: (r.stage as { label?: string } | undefined)?.label ?? null,
              priority: r.priority ?? null,
              ownerId: r.ownerId ?? null,
              slaDueAt: r.slaDueAt ?? null,
              updatedAt: r.updatedAt ?? null,
            })),
        };
      },
    },
    {
      name: "get_ticket",
      description: "Open one ticket by id: its stage, owner, SLA, value and linked records.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      kind: "read",
      permissions: ["tickets.view"],
      label: ["Reading a ticket", "قراءة تذكرة"],
      async execute(ctx: ToolContext, input: { id: string }) {
        return (await openRecord(deps, ctx, "ticket", input.id)) ?? notFound("ticket");
      },
    },
  ];
}
