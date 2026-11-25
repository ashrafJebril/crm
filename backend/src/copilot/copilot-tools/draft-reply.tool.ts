import { z } from "zod";
import type { CopilotTool, ToolContext } from "./registry";
import { notFound, openRecord, type ReadToolDeps } from "./deps";

export const DRAFT_MAX = 4000;

/**
 * SP-18 `draft_reply` (ruling 6). The model writes the draft; this tool checks
 * the member could reply in that conversation (conversations.view and
 * conversations.create, and the conversation is visible to them), then shows
 * the draft as a card ("Copy to reply box"). It NEVER sends: there is no
 * channel or send path here. The member sends through the inbox.
 */
export function draftReplyTools(deps: ReadToolDeps): CopilotTool[] {
  return [
    {
      name: "draft_reply",
      description:
        "Show the member a reply draft for one conversation. Write the full reply text yourself in `text` (in the customer's language). It is never sent: the member reviews it, copies it to the reply box and sends it themselves.",
      inputSchema: z.object({
        conversationId: z.string().min(1).max(64),
        text: z.string().trim().min(1).max(DRAFT_MAX),
      }),
      kind: "read",
      permissions: ["conversations.view", "conversations.create"],
      label: ["Drafting a reply", "كتابة مسودة رد"],
      async execute(ctx: ToolContext, input: { conversationId: string; text: string }) {
        const record = await openRecord(deps, ctx, "conversation", input.conversationId);
        if (!record) return notFound("conversation");
        ctx.emit("draft", { conversationId: record.id, text: input.text });
        return { shown: true, sent: false, note: "The draft is shown to the member. It was not sent; the member decides." };
      },
    },
  ];
}
