/* eslint-disable @typescript-eslint/no-explicit-any */
import { ImportsService } from "../imports/imports.service";
import { buildProposal } from "./extraction-schema";
import { CatalogImportRunner } from "./catalog-import.runner";
import { CatalogImportResumeScheduler, STALE_RUN_MS } from "./catalog-import-resume.scheduler";
import { A, B, importWorld } from "./catalog-import-test-world";

/** A runner that "dies" right after committing item `at` (between transactions). */
class CrashingRunner extends CatalogImportRunner {
  constructor(prisma: any, private readonly at: number) {
    super(prisma);
  }
  protected async afterItem(index: number): Promise<void> {
    if (index === this.at) throw new Error("process killed");
  }
}

async function runningJob(w: ReturnType<typeof importWorld>) {
  // 8 services and 4 staff; staff link services by name (from this run and the catalog).
  const existing = await w.services.create(A, { name: "Massage", nameAr: "مساج", durationMin: 60 });
  const proposal = buildProposal(
    {
      services: Array.from({ length: 8 }, (_, i) => ({ name: `Service ${i + 1}`, nameAr: `خدمة ${i + 1}`, durationMin: 30 + i })),
      staff: [
        { name: "Sara", services: ["service 1", "Massage", "Unknown thing"], schedule: { mon: [{ from: "09:00", to: "17:00" }] } },
        { name: "Lina", services: ["خدمه 2"] }, // Arabic normalization (ة/ه)
        { name: "Omar", services: [] },
        { name: "Huda", services: ["SERVICE 8"] },
      ],
    },
    "auto",
    { services: [{ id: existing.id, name: existing.name, nameAr: existing.nameAr }], staff: [] },
  );
  const now = new Date();
  const job = await w.prisma.catalogImport.create({
    data: {
      workspaceId: A,
      createdById: "uOwner",
      source: "paste",
      kind: "auto",
      status: "running",
      inputText: "still here",
      proposal,
      total: 12,
      startedAt: now,
      heartbeatAt: now,
    },
  });
  return { job, existing };
}

describe("catalog run resumes without duplicates", () => {
  it("a run killed after item 7 of 12 is resumed by the scheduler and ends with exactly 12 creates", async () => {
    const w = importWorld();
    const { job, existing } = await runningJob(w);
    const crashing = new CrashingRunner(w.prisma, 6); // index 6 = the 7th item
    await crashing.run(job.id);
    let row = w.prisma.db.catalogImport.find((j: any) => j.id === job.id);
    expect(row).toMatchObject({ status: "running", processed: 7, created: 7 });
    expect(w.prisma.db.service.filter((s: any) => s.name.startsWith("Service "))).toHaveLength(7);

    // Not stale yet: nothing resumes.
    expect(await w.scheduler.sweep(new Date())).toBe(0);
    // Two instances sweep at once after the heartbeat went stale: one claims it.
    const later = new Date(Date.now() + STALE_RUN_MS + 1000);
    const runnerB = new CatalogImportRunner(w.prisma as any);
    const kickB = jest.spyOn(runnerB, "kick").mockImplementation(() => undefined);
    const otherInstance = new CatalogImportResumeScheduler(w.prisma as any, runnerB);
    const [a, b] = await Promise.all([w.scheduler.sweep(later), otherInstance.sweep(later)]);
    expect(a + b).toBe(1);
    const winner = a === 1 ? w.runner : runnerB;
    expect(a === 1 ? (w.runner.kick as jest.Mock) : kickB).toHaveBeenCalledWith(job.id);
    await winner.run(job.id);

    row = w.prisma.db.catalogImport.find((j: any) => j.id === job.id);
    expect(row).toMatchObject({ status: "done", processed: 12, created: 12, failed: 0, inputText: null });
    expect(row.finishedAt).toBeInstanceOf(Date);
    // Exactly 8 new services and 4 staff: nothing twice.
    expect(w.prisma.db.service.filter((s: any) => s.name.startsWith("Service "))).toHaveLength(8);
    expect(w.prisma.db.staffResource.map((r: any) => r.name).sort()).toEqual(["Huda", "Lina", "Omar", "Sara"]);

    // Staff link services from the same run and the catalog, by normalized name.
    const byName = (n: string) => w.prisma.db.service.find((s: any) => s.name === n).id;
    const links = (name: string) => {
      const r = w.prisma.db.staffResource.find((x: any) => x.name === name);
      return w.prisma.db.staffService.filter((l: any) => l.resourceId === r.id).map((l: any) => l.serviceId).sort();
    };
    expect(links("Sara")).toEqual([byName("Service 1"), existing.id].sort());
    expect(links("Lina")).toEqual([byName("Service 2")]);
    expect(links("Huda")).toEqual([byName("Service 8")]);
    expect(links("Omar")).toEqual([]);
    expect(w.prisma.db.staffResource.find((x: any) => x.name === "Sara").schedule).toEqual({ mon: [{ from: "09:00", to: "17:00" }] });
    // A service name with no match is a row error, not a failure.
    expect(row.errors).toEqual([{ key: "t1", name: "Sara", reason: "service_not_found", missing: ["Unknown thing"] }]);
  });

  it("a runner whose lease was taken stops without writing", async () => {
    const w = importWorld();
    const { job } = await runningJob(w);
    const row = w.prisma.db.catalogImport.find((j: any) => j.id === job.id);
    const stale = new CatalogImportRunner(w.prisma as any);
    // Another instance claims the job between our read and our first write.
    const orig = w.prisma.catalogImport.findFirst;
    w.prisma.catalogImport.findFirst = jest.fn(async (a: any) => {
      const r = await orig(a);
      row.heartbeatAt = new Date(Date.now() + 60_000);
      return r;
    });
    await stale.run(job.id);
    expect(row).toMatchObject({ status: "running", processed: 0, created: 0 });
    expect(w.prisma.db.service.filter((s: any) => s.name.startsWith("Service "))).toHaveLength(0);
  });

  it("an item that fails to write is counted as failed and the run carries on", async () => {
    const w = importWorld();
    const { job } = await runningJob(w);
    const orig = w.prisma.service.create;
    w.prisma.service.create = jest.fn((a: any) => {
      if (a.data.name === "Service 3") throw new Error("boom");
      return orig(a);
    });
    await w.runner.run(job.id);
    const row = w.prisma.db.catalogImport.find((j: any) => j.id === job.id);
    expect(row).toMatchObject({ status: "done", processed: 12, failed: 1, created: 11 });
    expect(row.errors).toContainEqual({ key: "s3", name: "Service 3", reason: "write_failed" });
  });

  it("only selected items run; a stale extraction is failed by the sweep", async () => {
    const w = importWorld();
    const proposal = buildProposal({ services: [{ name: "A1", durationMin: 30 }, { name: "A2", durationMin: 30 }], staff: [] }, "services", { services: [], staff: [] });
    proposal.items[1].selected = false;
    const now = new Date();
    const job = await w.prisma.catalogImport.create({
      data: { workspaceId: A, source: "paste", kind: "services", status: "running", proposal, total: 1, skipped: 1, startedAt: now, heartbeatAt: now },
    });
    await w.runner.run(job.id);
    expect(w.prisma.db.service.map((s: any) => s.name)).toEqual(["A1"]);
    const ex = await w.prisma.catalogImport.create({
      data: { workspaceId: A, source: "paste", kind: "auto", status: "extracting", inputText: "x", heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    await w.scheduler.sweep(new Date());
    expect(w.prisma.db.catalogImport.find((j: any) => j.id === ex.id)).toMatchObject({
      status: "failed",
      errorKey: "catalog_import.ai_failed",
      inputText: null,
    });
  });
});

describe("main's import history does not list catalog jobs", () => {
  it("GET /imports lists only contacts and audience jobs (ruling 1)", async () => {
    const w = importWorld();
    w.prisma.db.importJob = [
      { id: "i1", workspaceId: A, kind: "contacts", status: "done", createdAt: new Date(1), fileMediaId: "m", options: {} },
      { id: "i2", workspaceId: A, kind: "audience", status: "done", createdAt: new Date(2), fileMediaId: "m", options: {} },
      { id: "i3", workspaceId: A, kind: "catalog", status: "running", createdAt: new Date(3), fileMediaId: "m", options: {} },
      { id: "i4", workspaceId: B, kind: "contacts", status: "done", createdAt: new Date(4), fileMediaId: "m", options: {} },
    ];
    const findMany = jest.fn(async (a: any) =>
      w.prisma.db.importJob.filter(
        (j: any) => j.workspaceId === a.where.workspaceId && (!a.where.kind || a.where.kind.in.includes(j.kind)),
      ),
    );
    const svc = new ImportsService({ importJob: { findMany } } as any, {} as any, {} as any, {} as any);
    const ids = (await svc.list(A)).map((j: any) => j.id).sort();
    expect(ids).toEqual(["i1", "i2"]);
    expect(findMany.mock.calls[0][0].where).toEqual({ workspaceId: A, kind: { in: ["contacts", "audience"] } });
    // The catalog import table is separate: main's ImportJob sweeps never see it.
    expect(w.prisma.db.catalogImport).toEqual([]);
  });
});
