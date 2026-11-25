import { z } from "zod";
import type { CopilotTool, ToolContext } from "./registry";
import type { ReadToolDeps } from "./deps";

/**
 * SP-18 `summarize_insights` (SP-11). The numbers are computed by the server
 * as the member (their conversation scope applies), never taken from the
 * page. Registered only when the SP-11 module is present (ruling 11).
 */
export function insightsTools(deps: ReadToolDeps): CopilotTool[] {
  if (!deps.insights) return [];
  const insights = deps.insights;
  return [
    {
      name: "summarize_insights",
      description:
        "Get the support or sales insights for a date range (YYYY-MM-DD, workspace time zone), optionally for one channel (support) or one pipeline (sales). Use it to explain the numbers.",
      inputSchema: z.object({
        kind: z.enum(["support", "sales"]),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        channelId: z.string().max(64).optional(),
        pipelineId: z.string().max(64).optional(),
      }),
      kind: "read",
      permissions: ["reports.view"],
      label: ["Reading your insights", "قراءة التحليلات"],
      async execute(ctx: ToolContext, input: { kind: "support" | "sales"; from?: string; to?: string; channelId?: string; pipelineId?: string }) {
        const data =
          input.kind === "support"
            ? await insights.support(ctx.workspaceId, { from: input.from, to: input.to, channelId: input.channelId }, ctx.viewer, ctx.now)
            : await insights.sales(ctx.workspaceId, { from: input.from, to: input.to, pipelineId: input.pipelineId }, ctx.viewer, ctx.now);
        return { kind: input.kind, insights: data };
      },
    },
  ];
}
