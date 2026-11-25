/**
 * Proves the "ticket_sla_due_at" trigger (migration
 * 20261116120000_support_tickets) against a real Postgres. Skipped unless
 * TICKETS_TEST_DATABASE_URL points at a migrated database (Task 3 runs it).
 * It creates its own throwaway workspace and deletes it (cascade) at the end;
 * it never touches other rows.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TicketsService } from "./tickets.service";

const url = process.env.TICKETS_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const MIN = 60_000;

// ~15 sequential round trips to a remote Postgres; jest's 5 s default is too
// tight (SP-09 live verification note).
jest.setTimeout(60_000);

d("SP-09 SLA trigger against Postgres", () => {
  let prisma: PrismaService;
  let svc: TicketsService;
  let wsId: string;
  let contactId: string;
  const stage: Record<string, string> = {};
  const pipelineId = `pl-${randomUUID()}`;

  /** The database clock (the trigger's now()), in UTC. */
  const dbNow = async (): Promise<Date> => {
    const [r] = await prisma.raw.$queryRawUnsafe<Array<{ n: Date }>>(`SELECT timezone('UTC', now())::timestamp(3) AS n`);
    return r.n;
  };
  const row = (id: string) => prisma.raw.ticket.findUniqueOrThrow({ where: { id } });
  const near = (a: Date | null, b: Date, slackMs = 5_000) => {
    expect(a).not.toBeNull();
    expect(Math.abs(a!.getTime() - b.getTime())).toBeLessThanOrEqual(slackMs);
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    svc = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never);
    const ws = await prisma.raw.workspace.create({
      data: { name: "SP-09 SLA spec", slug: `sp09-sla-${randomUUID()}` },
    });
    wsId = ws.id;
    await prisma.raw.pipeline.create({
      data: { id: pipelineId, workspaceId: wsId, key: `support-${randomUUID().slice(0, 8)}`, name: "Support", nameAr: "الدعم", kind: "support" },
    });
    const stages: Array<[string, number, boolean, boolean, number | null]> = [
      ["open", 0, false, false, 120],
      ["in_progress", 1, false, false, 1440],
      ["pending_customer", 2, false, false, null],
      ["resolved", 3, true, true, 60],
    ];
    for (const [key, order, isTerminal, isWon, slaMinutes] of stages) {
      const s = await prisma.raw.ticketStage.create({
        data: { workspaceId: wsId, pipelineId, key, label: key, labelAr: key, color: "info", order, groupKey: "new", isTerminal, isWon, slaMinutes },
      });
      stage[key] = s.id;
    }
    const c = await prisma.raw.contact.create({
      data: { workspaceId: wsId, name: "SLA spec", industry: "—", lifecycle: "customer", source: "whatsapp", lastSeen: "now" },
    });
    contactId = c.id;
  });

  /**
   * Cleanup in FK order, failing loudly (review M5): Ticket.stageId is
   * ON DELETE RESTRICT, so a workspace cascade could hit a stage while its
   * tickets still exist. Any error or residue fails the run and names the
   * workspace id, so Task 3 can clean up by hand on the production DB.
   */
  afterAll(async () => {
    try {
      if (!wsId) return;
      const where = { workspaceId: wsId };
      try {
        await prisma.raw.ticketActivity.deleteMany({ where });
        await prisma.raw.ticket.deleteMany({ where });
        await prisma.raw.ticketStage.deleteMany({ where });
        await prisma.raw.pipeline.deleteMany({ where });
        await prisma.raw.contact.deleteMany({ where });
        await prisma.raw.workspace.delete({ where: { id: wsId } });
      } catch (e) {
        throw new Error(`SP-09 DB spec cleanup failed for workspace ${wsId}: ${(e as Error).message}`);
      }
      const residue = {
        workspace: await prisma.raw.workspace.count({ where: { id: wsId } }),
        ticket: await prisma.raw.ticket.count({ where }),
        ticketStage: await prisma.raw.ticketStage.count({ where }),
        pipeline: await prisma.raw.pipeline.count({ where }),
        contact: await prisma.raw.contact.count({ where }),
      };
      if (Object.values(residue).some((n) => n > 0)) {
        throw new Error(`SP-09 DB spec left rows for workspace ${wsId}: ${JSON.stringify(residue)}`);
      }
    } finally {
      await prisma.onModuleDestroy();
    }
  });

  it("the trigger's default entry time and due date are UTC-correct on a non-UTC session (M6)", async () => {
    // A Prisma create inside a session whose TimeZone is Asia/Riyadh (UTC+3).
    const created = await prisma.raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Riyadh'`);
      const [tz] = await tx.$queryRawUnsafe<Array<{ tz: string }>>(`SELECT current_setting('TimeZone') AS tz`);
      expect(tz.tz).toBe("Asia/Riyadh");
      const n = await tx.ticket.count({ where: { pipelineId } });
      return tx.ticket.create({
        data: { workspaceId: wsId, number: 8000 + n, pipelineId, stageId: stage.open, contactId, title: "tz create" },
      });
    });
    let r = await row(created.id);
    near(r.enteredStageAt, await dbNow());
    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));

    // A raw stage UPDATE without enteredStageAt on that session: the trigger's
    // own default (UTC now) must not shift by the session offset (3 h).
    await prisma.raw.$transaction([
      prisma.raw.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Riyadh'`),
      prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = $1 WHERE "id" = $2`, stage.in_progress, created.id),
    ]);
    r = await row(created.id);
    near(r.slaDueAt, new Date((await dbNow()).getTime() + 1440 * MIN));
  });

  it("slaDueAt recalculated on stage change", async () => {
    const t = await svc.createTicket(wsId, { pipelineId, stageId: stage.open, contactId, title: "AC broken" });
    let r = await row(t.id);
    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));

    await svc.moveTicket(wsId, t.id, { stageId: stage.in_progress });
    r = await row(t.id);
    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 1440 * MIN));

    const before = r.slaDueAt;
    await svc.updateTicket(wsId, t.id, { title: "AC still broken", priority: "urgent", category: "complaint" });
    r = await row(t.id);
    expect(r.slaDueAt).toEqual(before);
    expect(r.priority).toBe("urgent");

    await svc.moveTicket(wsId, t.id, { stageId: stage.pending_customer });
    expect((await row(t.id)).slaDueAt).toBeNull();

    await svc.moveTicket(wsId, t.id, { stageId: stage.open });
    await svc.moveTicket(wsId, t.id, { stageId: stage.resolved });
    expect((await row(t.id)).slaDueAt).toBeNull(); // terminal, even with slaMinutes

    await svc.reopenTicket(wsId, t.id);
    r = await row(t.id);
    expect(r.stageId).toBe(stage.open);
    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));
  });

  it("sla trigger covers every stage writer", async () => {
    // A raw INSERT that does not mention slaDueAt (the deployed main, imports).
    const id = `tk-${randomUUID()}`;
    const entered = new Date("2026-11-16T06:00:00.000Z");
    await prisma.raw.$executeRawUnsafe(
      `INSERT INTO "Ticket" ("id","number","pipelineId","stageId","contactId","title","workspaceId","updatedAt","enteredStageAt")
       VALUES ($1, 9001, $2, $3, $4, 'raw insert', $5, now(), $6)`,
      id, pipelineId, stage.open, contactId, wsId, entered,
    );
    expect((await row(id)).slaDueAt).toEqual(new Date(entered.getTime() + 120 * MIN));

    // A raw stage UPDATE without enteredStageAt: based on now().
    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = $1 WHERE "id" = $2`, stage.in_progress, id);
    near((await row(id)).slaDueAt, new Date((await dbNow()).getTime() + 1440 * MIN));

    // A raw stage UPDATE that sets enteredStageAt (bulk, stage delete, undo): based on it.
    const moved = new Date("2026-11-16T07:30:00.000Z");
    await prisma.raw.$executeRawUnsafe(
      `UPDATE "Ticket" SET "stageId" = $1, "enteredStageAt" = $2 WHERE "id" = $3`,
      stage.open, moved, id,
    );
    expect((await row(id)).slaDueAt).toEqual(new Date(moved.getTime() + 120 * MIN));

    // updateMany (Prisma) to a terminal stage and back to a no-SLA stage.
    await prisma.raw.ticket.updateMany({ where: { id }, data: { stageId: stage.resolved, enteredStageAt: new Date() } });
    expect((await row(id)).slaDueAt).toBeNull();
    await prisma.raw.ticket.updateMany({ where: { id }, data: { stageId: stage.pending_customer } });
    expect((await row(id)).slaDueAt).toBeNull();
  });

  it("sla unchanged when other fields change", async () => {
    const t = await svc.createTicket(wsId, { pipelineId, stageId: stage.in_progress, contactId, title: "Refund" });
    const due = (await row(t.id)).slaDueAt;
    expect(due).not.toBeNull();
    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "title" = 'x', "priority" = 'high', "enteredStageAt" = now() WHERE "id" = $1`, t.id);
    // Same stageId written again is not a stage change either.
    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = "stageId" WHERE "id" = $1`, t.id);
    expect((await row(t.id)).slaDueAt).toEqual(due);
  });
});
