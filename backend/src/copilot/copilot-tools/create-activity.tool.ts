import { z } from "zod";
import { ACTIVITY_KINDS, DUE_REQUIRED_KINDS, type CreateActivityDto } from "../../activities/activities.dto";
import { WRITE_EXECUTE, type CopilotTool, type ExecContext, type Recheck, type ToolContext, type ToolRefusal, type WriteProposal } from "./registry";
import { refusal, type WriteToolDeps } from "./write-deps";

type Input = { kind: (typeof ACTIVITY_KINDS)[number]; title: string; notes?: string; dueAt?: string; contactId?: string; ticketId?: string };

/** The record the activity hangs on, read as the member (null when they cannot open it). */
async function target(deps: WriteToolDeps, ws: string, viewer: ExecContext["viewer"], args: { ticketId?: unknown; contactId?: unknown }) {
  const kind = args.ticketId ? "ticket" : "contact";
  const id = String(args.ticketId ?? args.contactId ?? "");
  try {
    return await deps.records.get(ws, viewer, kind, id);
  } catch {
    return null;
  }
}

/**
 * SP-18 `create_activity` (low risk; on the auto-apply list). A follow-up,
 * call, meeting, task or logged note on a customer or a ticket. Applied
 * through ActivitiesService.create as the member: a ticket activity needs
 * tickets.update, a customer activity contacts.update (the service's rule).
 */
export function createActivityTool(deps: WriteToolDeps): CopilotTool {
  return {
    name: "create_activity",
    description:
      "Propose an activity (follow_up, call, meeting, task or note_log) on a customer (contactId) or a ticket (ticketId). follow_up and task need dueAt (ISO 8601 with an offset). Nothing is saved until the member approves the card, unless their approval mode applies it.",
    inputSchema: z.object({
      kind: z.enum(ACTIVITY_KINDS as unknown as [string, ...string[]]),
      title: z.string().trim().min(1).max(300),
      notes: z.string().max(5000).optional(),
      dueAt: z.string().datetime({ offset: true }).optional(),
      contactId: z.string().min(1).max(64).optional(),
      ticketId: z.string().min(1).max(64).optional(),
    }),
    kind: "write",
    // Checked per proposal: tickets.update or contacts.update, by the target.
    permissions: [],
    risk: "low",
    label: ["Preparing an activity", "تجهيز نشاط"],
    execute: WRITE_EXECUTE,
    async propose(ctx: ToolContext, input: Input): Promise<WriteProposal | ToolRefusal> {
      if (!input.ticketId && !input.contactId) return refusal("invalid", "Name the customer (contactId) or the ticket (ticketId).");
      if (DUE_REQUIRED_KINDS.includes(input.kind) && !input.dueAt) return refusal("invalid", `A ${input.kind} needs dueAt.`);
      const args: Record<string, unknown> = { kind: input.kind, title: input.title };
      if (input.notes) args.notes = input.notes;
      if (input.dueAt) args.dueAt = new Date(input.dueAt).toISOString();
      if (input.ticketId) args.ticketId = input.ticketId;
      else args.contactId = input.contactId;
      const record = await target(deps, ctx.workspaceId, ctx.viewer, args);
      if (!record) return refusal("not_found", `No ${input.ticketId ? "ticket" : "customer"} with that id is available to this member.`);
      return {
        args,
        permission: input.ticketId ? "tickets.update" : "contacts.update",
        risk: "low",
        card: {
          title: "create_activity",
          changes: [
            { label: "activity.kind", after: input.kind },
            { label: "activity.title", after: input.title },
            ...(args.dueAt ? [{ label: "activity.dueAt", after: String(args.dueAt) }] : []),
            { label: input.ticketId ? "activity.ticket" : "activity.contact", after: record.title },
          ],
        },
      };
    },
    async recheck(exec: ExecContext, args): Promise<Recheck> {
      return (await target(deps, exec.workspaceId, exec.viewer, args)) ? "ok" : "permission_revoked";
    },
    async apply(exec: ExecContext, args) {
      const row = await deps.activities.create(exec.workspaceId, args as unknown as CreateActivityDto, exec.viewer.userId, exec.viewer);
      // The record it hangs on, so the receipt can link to it.
      return { activityId: (row as { id: string }).id, ...(args.ticketId ? { ticketId: String(args.ticketId) } : { contactId: String(args.contactId) }) };
    },
  };
}
