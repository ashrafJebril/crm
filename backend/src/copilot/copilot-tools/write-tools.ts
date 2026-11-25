/** SP-18: the first write tools (ruling 3 risk levels: create_activity low, move_ticket_stage medium/high, save_attachment_to_knowledge high). */
import type { CopilotTool } from "./registry";
import type { WriteToolDeps } from "./write-deps";
import { createActivityTool } from "./create-activity.tool";
import { moveTicketStageTool } from "./move-ticket-stage.tool";
import { saveAttachmentTool } from "./save-attachment.tool";

export function writeTools(deps: WriteToolDeps): CopilotTool[] {
  return [createActivityTool(deps), moveTicketStageTool(deps), saveAttachmentTool(deps)].filter((t): t is CopilotTool => !!t);
}
