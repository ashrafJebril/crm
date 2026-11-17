/* eslint-disable @typescript-eslint/no-explicit-any */
import { MulterError } from "multer";
import { AGENT, NOW, WRITER, WS, copilotWorld, viewer } from "../copilot-test-world";
import { SourceCollector } from "../copilot-sources";
import { mapAttachError } from "../copilot-upload.interceptor";
import { CardOutdated, type ExecContext, type ToolContext } from "./registry";

const ctxFor = (userId: string, sessionId = "s1"): ToolContext => ({
  workspaceId: WS,
  viewer: viewer(userId),
  sessionId,
  lang: "en",
  now: NOW,
  sources: new SourceCollector(),
  taint: () => undefined,
  isTainted: () => false,
  emit: () => undefined,
});
const execFor = (userId: string, sessionId = "s1"): ExecContext => ({ workspaceId: WS, viewer: viewer(userId), sessionId, now: NOW });

describe("copilot write tools", () => {
  it("never execute from the loop; propose builds a card and writes nothing", async () => {
    const w = copilotWorld();
    for (const n of ["create_activity", "move_ticket_stage", "save_attachment_to_knowledge"]) {
      await expect(w.registry.get(n)!.execute(ctxFor(WRITER), {} as never)).rejects.toThrow(/propose/);
    }
    const p: any = await w.registry.get("create_activity")!.propose!(ctxFor(WRITER), { kind: "call", title: "Call", ticketId: "t-hidden", contactId: "c-layla" } as never);
    expect(p).toMatchObject({ permission: "tickets.update", risk: "low", args: { kind: "call", title: "Call", ticketId: "t-hidden" } });
    expect(p.args.contactId).toBeUndefined();
    expect(w.activities.create).not.toHaveBeenCalled();
  });

  it("create_activity: the target must be open to the member; recheck follows it; apply goes through ActivitiesService", async () => {
    const w = copilotWorld();
    const t = w.registry.get("create_activity")!;
    // The assigned-only agent has no tickets.view: the ticket is not found.
    expect(await t.propose!(ctxFor(AGENT), { kind: "call", title: "x", ticketId: "t-hidden" } as never)).toMatchObject({ error: "not_found" });
    expect(await t.propose!(ctxFor(WRITER), { kind: "call", title: "x" } as never)).toMatchObject({ error: "invalid" });
    expect(await t.recheck!(execFor(WRITER), { contactId: "c-layla" })).toBe("ok");
    expect(await t.recheck!(execFor(WRITER), { contactId: "c-foreign" })).toBe("permission_revoked");
    expect(await t.apply!(execFor(WRITER), { kind: "call", title: "x", contactId: "c-layla" })).toEqual({ activityId: "act-1" });
  });

  it("move_ticket_stage: risk by target, recheck against the sealed stage, conflicts become CardOutdated", async () => {
    const w = copilotWorld();
    const t = w.registry.get("move_ticket_stage")!;
    expect(await t.propose!(ctxFor(WRITER), { ticketId: "t-hidden", stageId: "s2" } as never)).toMatchObject({ risk: "medium", args: { fromStageId: "s1" } });
    expect(await t.propose!(ctxFor(WRITER), { ticketId: "t-hidden", stageId: "s-won" } as never)).toMatchObject({ risk: "high" });
    expect(await t.propose!(ctxFor(WRITER), { ticketId: "t-hidden", stageId: "s-lost", note: "No reply" } as never)).toMatchObject({ risk: "high", args: { note: "No reply" } });
    expect(await t.recheck!(execFor(WRITER), { ticketId: "t-hidden", fromStageId: "s1" })).toBe("ok");
    expect(await t.recheck!(execFor(WRITER), { ticketId: "t-hidden", fromStageId: "s2" })).toBe("card_outdated");
    expect(await t.recheck!(execFor(AGENT), { ticketId: "t-hidden", fromStageId: "s1" })).toBe("permission_revoked");
    w.db.ticket.find((x) => x.id === "t-hidden").stageId = "s2";
    await expect(t.apply!(execFor(WRITER), { ticketId: "t-hidden", stageId: "s-won", fromStageId: "s1" })).rejects.toBeInstanceOf(CardOutdated);
    expect(await t.apply!(execFor(WRITER), { ticketId: "t-hidden", stageId: "s-won", fromStageId: "s2" })).toEqual({ ticketId: "t-hidden", stageId: "s-won" });
  });

  it("save_attachment_to_knowledge: only a file sent in this chat, KB types only, through KnowledgeSourcesService", async () => {
    const w = copilotWorld();
    const t = w.registry.get("save_attachment_to_knowledge")!;
    const csv = await w.attachments.upload(WS, WRITER, { originalname: "p.csv", buffer: Buffer.from("a,b\n1,2\n") });
    const txt = await w.attachments.upload(WS, WRITER, { originalname: "n.txt", buffer: Buffer.from("hello") });
    // Not sent yet: not found.
    expect(await t.propose!(ctxFor(WRITER), { attachmentId: csv.id } as never)).toMatchObject({ error: "not_found" });
    await w.attachments.claim(WS, WRITER, "s1", [csv.id, txt.id]);
    expect(await t.propose!(ctxFor(WRITER), { attachmentId: csv.id } as never)).toMatchObject({ risk: "high", permission: "knowledge.create", args: { attachmentId: csv.id } });
    expect(await t.propose!(ctxFor(WRITER), { attachmentId: txt.id } as never)).toMatchObject({ error: "invalid" });
    // Another session or member: not found.
    expect(await t.propose!(ctxFor(WRITER, "s2"), { attachmentId: csv.id } as never)).toMatchObject({ error: "not_found" });
    expect(await t.propose!(ctxFor(AGENT), { attachmentId: csv.id } as never)).toMatchObject({ error: "not_found" });
    expect(await t.apply!(execFor(WRITER), { attachmentId: csv.id })).toEqual({ sourceId: "ks-saved" });
    expect(w.knowledgeSources.uploadFiles).toHaveBeenCalledWith(WS, WRITER, [{ buffer: Buffer.from("a,b\n1,2\n"), originalname: "p.csv", mimetype: "text/csv", size: 8 }]);
  });

  it("upload errors map to copilot keys", () => {
    expect(mapAttachError(new MulterError("LIMIT_FILE_SIZE")).getResponse()).toMatchObject({ message: "copilot.attachment_too_large" });
    expect(mapAttachError(new MulterError("LIMIT_UNEXPECTED_FILE")).getResponse()).toMatchObject({ message: "copilot.too_many_attachments" });
    expect(mapAttachError(new Error("x")).getResponse()).toMatchObject({ message: "copilot.attachment_type" });
  });
});
