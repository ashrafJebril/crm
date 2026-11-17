import { z } from "zod";
import type { CopilotTool, ToolContext } from "./registry";
import { notFound, openRecord, type ReadToolDeps } from "./deps";

/** SP-18 contacts: search (SearchService, the member's gating) and one contact (RecordsService). */
export function contactTools(deps: ReadToolDeps): CopilotTool[] {
  return [
    {
      name: "search_contacts",
      description: "Search this workspace's customers by name, phone or email. Returns up to `limit` matches with their id.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).describe("Words from the customer's name, phone or email"),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      kind: "read",
      permissions: ["contacts.view"],
      label: ["Searching customers", "البحث في العملاء"],
      async execute(ctx: ToolContext, input: { query: string; limit?: number }) {
        const res = await deps.search.search(ctx.workspaceId, input.query, input.limit ?? 10, ctx.viewer);
        return { contacts: res.contacts.slice(0, input.limit ?? 10) };
      },
    },
    {
      name: "get_contact",
      description: "Open one customer by id: their details and links to their recent conversations, open tickets and upcoming bookings.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      kind: "read",
      permissions: ["contacts.view"],
      label: ["Reading a customer", "قراءة بيانات عميل"],
      async execute(ctx: ToolContext, input: { id: string }) {
        return (await openRecord(deps, ctx, "contact", input.id)) ?? notFound("customer");
      },
    },
  ];
}
