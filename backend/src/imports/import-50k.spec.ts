import { FakePrisma, makeRunner, seedJob } from "./imports-test-fakes";
import { MAX_IMPORT_ROWS } from "./parse-file";

// Review Focus 1: a 50 000-row import runs in 500-row batches, persists progress
// after every batch and yields the event loop between batches.
describe("import of 50 000 rows", () => {
  jest.setTimeout(120_000);

  it("runs in 100 batches with a progress write and a yield after each", async () => {
    const lines = ["Name,Phone,Email"];
    for (let i = 0; i < 50_000; i++) {
      lines.push(`Contact ${i},+9715${String(10_000_000 + i)},c${i}@example.com`);
    }
    expect(lines.length - 1).toBe(MAX_IMPORT_ROWS);

    const prisma = new FakePrisma();
    seedJob(prisma, { totalRows: 50_000 });
    const { runner, notifications } = makeRunner(prisma, lines.join("\n"));
    const yields = jest.spyOn(runner as unknown as { yieldTick(): Promise<void> }, "yieldTick");
    const createMany = jest.spyOn(prisma.contact, "createMany");

    await runner.run("job-seed");

    expect(createMany).toHaveBeenCalledTimes(100);
    expect(createMany.mock.calls.every(([a]: any) => a.data.length === 500)).toBe(true);
    expect(yields).toHaveBeenCalledTimes(100);

    const progress = prisma.jobUpdates.filter((u) => u.processed !== undefined && u.status === undefined);
    expect(progress).toHaveLength(100);
    expect(progress.map((u) => u.processed)).toEqual(Array.from({ length: 100 }, (_, i) => (i + 1) * 500));
    expect(progress.every((u) => u.heartbeatAt instanceof Date)).toBe(true);

    expect(prisma.contacts.size).toBe(50_000);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "done", processed: 50_000, created: 50_000, failed: 0 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("never holds the event loop for a whole import: other work interleaves between batches", async () => {
    const lines = ["Name,Phone"];
    for (let i = 0; i < 2_000; i++) lines.push(`C${i},+9715${String(20_000_000 + i)}`);
    const prisma = new FakePrisma();
    seedJob(prisma, { mapping: { Name: "name", Phone: "phone" } });
    const { runner } = makeRunner(prisma, lines.join("\n"));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    await runner.run("job-seed");
    clearInterval(timer);
    expect(prisma.contacts.size).toBe(2_000);
    expect(ticks).toBeGreaterThan(0);
  });
});
