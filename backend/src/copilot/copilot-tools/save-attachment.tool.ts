import { z } from "zod";
import { WRITE_EXECUTE, type CopilotTool, type ExecContext, type Recheck, type ToolContext, type ToolRefusal, type WriteProposal } from "./registry";
import { refusal, type WriteToolDeps } from "./write-deps";

/** The knowledge base takes these attachment types (SP-21); plain text does not go there. */
const KNOWLEDGE_MIMES = new Set([
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * SP-18 `save_attachment_to_knowledge`: HIGH risk, so it always needs the
 * member's click (ruling 3). Saves a file the member attached in THIS chat to
 * the knowledge base through KnowledgeSourcesService.uploadFiles (its own type,
 * size and signature checks run again). Needs knowledge.create.
 */
export function saveAttachmentTool(deps: WriteToolDeps): CopilotTool | null {
  const knowledge = deps.knowledgeSources;
  if (!knowledge) return null;
  const load = async (ws: string, userId: string, id: string) => {
    try {
      return await deps.attachments.own(ws, userId, id);
    } catch {
      return null;
    }
  };
  return {
    name: "save_attachment_to_knowledge",
    description:
      "Propose saving a file the member attached in this chat (attachmentId) to the business's knowledge base. PDF, CSV, XLSX and images only. Always needs the member's approval.",
    inputSchema: z.object({ attachmentId: z.string().min(1).max(64) }),
    kind: "write",
    permissions: ["knowledge.create"],
    risk: "high",
    label: ["Preparing to save to knowledge", "تجهيز الحفظ في المعرفة"],
    execute: WRITE_EXECUTE,
    async propose(ctx: ToolContext, input: { attachmentId: string }): Promise<WriteProposal | ToolRefusal> {
      const a = await load(ctx.workspaceId, ctx.viewer.userId, input.attachmentId);
      if (!a || a.sessionId !== ctx.sessionId || !a.sentAt) return refusal("not_found", "No file with that id was attached in this chat.");
      if (!KNOWLEDGE_MIMES.has(a.mimeType)) return refusal("invalid", "The knowledge base takes PDF, CSV, XLSX and image files only.");
      return {
        args: { attachmentId: a.id },
        permission: "knowledge.create",
        risk: "high",
        card: { title: "save_attachment_to_knowledge", changes: [{ label: "knowledge.file", after: a.fileName }] },
      };
    },
    async recheck(exec: ExecContext, args): Promise<Recheck> {
      const a = await load(exec.workspaceId, exec.viewer.userId, String(args.attachmentId));
      return a && a.mediaId && a.sessionId === exec.sessionId ? "ok" : "card_outdated";
    },
    async apply(exec: ExecContext, args) {
      const a = await deps.attachments.own(exec.workspaceId, exec.viewer.userId, String(args.attachmentId));
      const buffer = await deps.attachments.readBytes(exec.workspaceId, a);
      const res = await knowledge.uploadFiles(exec.workspaceId, exec.viewer.userId, [
        { buffer, originalname: a.fileName, mimetype: a.mimeType, size: buffer.length },
      ]);
      return { sourceId: res.items[0]?.id ?? null };
    },
  };
}
