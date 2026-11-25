import { z } from "zod";
import type { CopilotTool, ToolContext } from "./registry";
import { notFound, openRecord, type ReadToolDeps } from "./deps";

/** SP-18 campaigns: the workspace's campaigns and one campaign's summary (RecordsService, with its SP-12 numbers). */
export function campaignTools(deps: ReadToolDeps): CopilotTool[] {
  return [
    {
      name: "list_campaigns",
      description: "List this workspace's campaigns, newest first, optionally by status.",
      inputSchema: z.object({
        status: z.enum(["draft", "scheduled", "running", "completed", "failed", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      kind: "read",
      permissions: ["campaigns.view"],
      label: ["Reading campaigns", "قراءة الحملات"],
      async execute(ctx: ToolContext, input: { status?: string; limit?: number }) {
        const rows = await deps.prisma.campaign.findMany({
          where: { workspaceId: ctx.workspaceId, ...(input.status ? { status: input.status } : {}) },
          orderBy: { createdAt: "desc" },
          take: input.limit ?? 20,
          select: { id: true, name: true, status: true, createdAt: true },
        });
        return { campaigns: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, createdAt: r.createdAt.toISOString() })) };
      },
    },
    {
      name: "get_campaign",
      description: "Open one campaign by id: its status, audience and delivery numbers.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      kind: "read",
      permissions: ["campaigns.view"],
      label: ["Reading a campaign", "قراءة حملة"],
      async execute(ctx: ToolContext, input: { id: string }) {
        return (await openRecord(deps, ctx, "campaign", input.id)) ?? notFound("campaign");
      },
    },
  ];
}
