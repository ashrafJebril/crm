// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

/**
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 * Proves the "ticket_sla_due_at" trigger (migration
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 * 20261116120000_support_tickets) against a real Postgres. Skipped unless
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 * TICKETS_TEST_DATABASE_URL points at a migrated database (Task 3 runs it).
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 * It creates its own throwaway workspace and deletes it (cascade) at the end;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 * it never touches other rows.
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

 */
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

import { randomUUID } from "crypto";
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

import { PrismaService } from "../prisma/prisma.service";
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

import { TicketsService } from "./tickets.service";
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

const url = process.env.TICKETS_TEST_DATABASE_URL;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

const d = url ? describe : describe.skip;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

const MIN = 60_000;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

d("SP-09 SLA trigger against Postgres", () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  let prisma: PrismaService;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  let svc: TicketsService;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  let wsId: string;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  let contactId: string;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  const stage: Record<string, string> = {};
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  const pipelineId = `pl-${randomUUID()}`;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  /** The database clock (the trigger's now()), in UTC. */
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  const dbNow = async (): Promise<Date> => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const [r] = await prisma.raw.$queryRawUnsafe<Array<{ n: Date }>>(`SELECT timezone('UTC', now())::timestamp(3) AS n`);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    return r.n;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  };
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  const row = (id: string) => prisma.raw.ticket.findUniqueOrThrow({ where: { id } });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  const near = (a: Date | null, b: Date, slackMs = 5_000) => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(a).not.toBeNull();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(Math.abs(a!.getTime() - b.getTime())).toBeLessThanOrEqual(slackMs);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  };
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  beforeAll(async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    process.env.DATABASE_URL = url;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    prisma = new PrismaService();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    svc = new TicketsService(prisma, { emitToWorkspace: jest.fn() } as never);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const ws = await prisma.raw.workspace.create({
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      data: { name: "SP-09 SLA spec", slug: `sp09-sla-${randomUUID()}` },
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    wsId = ws.id;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.pipeline.create({
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      data: { id: pipelineId, workspaceId: wsId, key: `support-${randomUUID().slice(0, 8)}`, name: "Support", nameAr: "الدعم", kind: "support" },
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const stages: Array<[string, number, boolean, boolean, number | null]> = [
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      ["open", 0, false, false, 120],
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      ["in_progress", 1, false, false, 1440],
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      ["pending_customer", 2, false, false, null],
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      ["resolved", 3, true, true, 60],
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    ];
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    for (const [key, order, isTerminal, isWon, slaMinutes] of stages) {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      const s = await prisma.raw.ticketStage.create({
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        data: { workspaceId: wsId, pipelineId, key, label: key, labelAr: key, color: "info", order, groupKey: "new", isTerminal, isWon, slaMinutes },
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      stage[key] = s.id;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    }
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const c = await prisma.raw.contact.create({
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      data: { workspaceId: wsId, name: "SLA spec", industry: "—", lifecycle: "customer", source: "whatsapp", lastSeen: "now" },
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    contactId = c.id;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  /**
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

   * Cleanup in FK order, failing loudly (review M5): Ticket.stageId is
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

   * ON DELETE RESTRICT, so a workspace cascade could hit a stage while its
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

   * tickets still exist. Any error or residue fails the run and names the
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

   * workspace id, so Task 3 can clean up by hand on the production DB.
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

   */
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  afterAll(async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    try {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      if (!wsId) return;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      const where = { workspaceId: wsId };
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      try {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.ticketActivity.deleteMany({ where });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.ticket.deleteMany({ where });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.ticketStage.deleteMany({ where });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.pipeline.deleteMany({ where });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.contact.deleteMany({ where });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        await prisma.raw.workspace.delete({ where: { id: wsId } });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      } catch (e) {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        throw new Error(`SP-09 DB spec cleanup failed for workspace ${wsId}: ${(e as Error).message}`);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      }
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      const residue = {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        workspace: await prisma.raw.workspace.count({ where: { id: wsId } }),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        ticket: await prisma.raw.ticket.count({ where }),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        ticketStage: await prisma.raw.ticketStage.count({ where }),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        pipeline: await prisma.raw.pipeline.count({ where }),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        contact: await prisma.raw.contact.count({ where }),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      };
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      if (Object.values(residue).some((n) => n > 0)) {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        throw new Error(`SP-09 DB spec left rows for workspace ${wsId}: ${JSON.stringify(residue)}`);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      }
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    } finally {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      await prisma.onModuleDestroy();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    }
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  it("the trigger's default entry time and due date are UTC-correct on a non-UTC session (M6)", async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // A Prisma create inside a session whose TimeZone is Asia/Riyadh (UTC+3).
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const created = await prisma.raw.$transaction(async (tx) => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Riyadh'`);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      const [tz] = await tx.$queryRawUnsafe<Array<{ tz: string }>>(`SELECT current_setting('TimeZone') AS tz`);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      expect(tz.tz).toBe("Asia/Riyadh");
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      const n = await tx.ticket.count({ where: { pipelineId } });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      return tx.ticket.create({
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

        data: { workspaceId: wsId, number: 8000 + n, pipelineId, stageId: stage.open, contactId, title: "tz create" },
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    let r = await row(created.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    near(r.enteredStageAt, await dbNow());
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // A raw stage UPDATE without enteredStageAt on that session: the trigger's
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // own default (UTC now) must not shift by the session offset (3 h).
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$transaction([
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      prisma.raw.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Riyadh'`),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = $1 WHERE "id" = $2`, stage.in_progress, created.id),
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    ]);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    r = await row(created.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    near(r.slaDueAt, new Date((await dbNow()).getTime() + 1440 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  it("slaDueAt recalculated on stage change", async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const t = await svc.createTicket(wsId, { pipelineId, stageId: stage.open, contactId, title: "AC broken" });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    let r = await row(t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.moveTicket(wsId, t.id, { stageId: stage.in_progress });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    r = await row(t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 1440 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const before = r.slaDueAt;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.updateTicket(wsId, t.id, { title: "AC still broken", priority: "urgent", category: "complaint" });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    r = await row(t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.slaDueAt).toEqual(before);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.priority).toBe("urgent");
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.moveTicket(wsId, t.id, { stageId: stage.pending_customer });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(t.id)).slaDueAt).toBeNull();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.moveTicket(wsId, t.id, { stageId: stage.open });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.moveTicket(wsId, t.id, { stageId: stage.resolved });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(t.id)).slaDueAt).toBeNull(); // terminal, even with slaMinutes
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await svc.reopenTicket(wsId, t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    r = await row(t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.stageId).toBe(stage.open);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(r.slaDueAt).toEqual(new Date(r.enteredStageAt.getTime() + 120 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  it("sla trigger covers every stage writer", async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // A raw INSERT that does not mention slaDueAt (the deployed main, imports).
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const id = `tk-${randomUUID()}`;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const entered = new Date("2026-11-16T06:00:00.000Z");
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$executeRawUnsafe(
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      `INSERT INTO "Ticket" ("id","number","pipelineId","stageId","contactId","title","workspaceId","updatedAt","enteredStageAt")
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

       VALUES ($1, 9001, $2, $3, $4, 'raw insert', $5, now(), $6)`,
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      id, pipelineId, stage.open, contactId, wsId, entered,
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    );
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(id)).slaDueAt).toEqual(new Date(entered.getTime() + 120 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // A raw stage UPDATE without enteredStageAt: based on now().
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = $1 WHERE "id" = $2`, stage.in_progress, id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    near((await row(id)).slaDueAt, new Date((await dbNow()).getTime() + 1440 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // A raw stage UPDATE that sets enteredStageAt (bulk, stage delete, undo): based on it.
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const moved = new Date("2026-11-16T07:30:00.000Z");
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$executeRawUnsafe(
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      `UPDATE "Ticket" SET "stageId" = $1, "enteredStageAt" = $2 WHERE "id" = $3`,
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

      stage.open, moved, id,
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    );
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(id)).slaDueAt).toEqual(new Date(moved.getTime() + 120 * MIN));
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // updateMany (Prisma) to a terminal stage and back to a no-SLA stage.
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.ticket.updateMany({ where: { id }, data: { stageId: stage.resolved, enteredStageAt: new Date() } });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(id)).slaDueAt).toBeNull();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.ticket.updateMany({ where: { id }, data: { stageId: stage.pending_customer } });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(id)).slaDueAt).toBeNull();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);


// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  it("sla unchanged when other fields change", async () => {
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const t = await svc.createTicket(wsId, { pipelineId, stageId: stage.in_progress, contactId, title: "Refund" });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    const due = (await row(t.id)).slaDueAt;
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect(due).not.toBeNull();
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "title" = 'x', "priority" = 'high', "enteredStageAt" = now() WHERE "id" = $1`, t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    // Same stageId written again is not a stage change either.
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    await prisma.raw.$executeRawUnsafe(`UPDATE "Ticket" SET "stageId" = "stageId" WHERE "id" = $1`, t.id);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

    expect((await row(t.id)).slaDueAt).toEqual(due);
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

  });
// ~15 sequential round trips to a remote Postgres; the 5 s default is too tight (live F1 note).
jest.setTimeout(60_000);

});
