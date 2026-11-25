import { FakePrisma, makeRunner, seedJob } from "./imports-test-fakes";
import { ImportResumeScheduler } from "./import-resume.scheduler";

const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `P${from + i},05011${String(from + i).padStart(5, "0")},p${from + i}@x.com`);
const csv = (...lines: string[]) => ["Name,Phone,Email", ...lines].join("\n");

describe("ImportRunnerService", () => {
  it("creates contacts, finishes the job and notifies the creator", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { totalRows: 3 });
    const { runner, notifications } = makeRunner(prisma, csv(...rows(2), "Bad,,nope"));
    await runner.run("job-seed");
    expect([...prisma.contacts.values()].map((c) => c.phone)).toEqual(["+97150110000" + "0", "+971501100001"]);
    const j = prisma.jobs.get("job-seed");
    expect(j).toMatchObject({ status: "done", processed: 3, created: 2, updated: 0, failed: 1 });
    expect(j.errors).toEqual([{ row: 4, column: "Email", key: "imports.err.bad_email" }]);
    expect(j.finishedAt).toBeInstanceOf(Date);
    expect(notifications.notify).toHaveBeenCalledWith("ws1", ["u1"], {
      type: "import_finished",
      title: "import.finished",
      body: JSON.stringify({ created: 2, updated: 0, failed: 1 }),
    });
  });

  it("stores contacts with split names, lowercase lifecycle, owner and custom values", async () => {
    const prisma = new FakePrisma();
    prisma.defs = [{ id: "dAge", key: "age", label: "Age", labelAr: "العمر", type: "number", options: null }];
    seedJob(prisma, {
      mapping: { Name: "name", Phone: "phone", Stage: "lifecycle", Owner: "owner", Age: "custom:dAge" },
    });
    const { runner } = makeRunner(prisma, "Name,Phone,Stage,Owner,Age\nAli Hassan,0501234567,Customer,agent@x.com,٣٠");
    await runner.run("job-seed");
    const c = [...prisma.contacts.values()][0];
    expect(c).toMatchObject({
      name: "Ali Hassan",
      firstName: "Ali",
      lastName: "Hassan",
      phone: "+971501234567",
      lifecycle: "customer",
      ownerId: "u2",
      workspaceId: "ws1",
    });
    expect(prisma.customValues).toEqual([{ defId: "dAge", contactId: c.id, value: 30 }]);
  });

  it("applies tags per distinct tag set via the set-based assign (option + row tags)", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { mapping: { Name: "name", Phone: "phone", Tags: "tags" }, options: { matchBy: "phone", updateExisting: false, tags: ["imported"] } });
    const { runner, tags } = makeRunner(prisma, "Name,Phone,Tags\nA,0501000001,\"vip, gold\"\nB,0501000002,vip؛gold\nC,0501000003,x");
    await runner.run("job-seed");
    const calls = tags.assign.mock.calls.map(([, input]) => ({ n: input.contactIds.length, add: input.add }));
    expect(calls).toContainEqual({ n: 1, add: ["gold", "imported", "vip"] });
    expect(calls).toContainEqual({ n: 1, add: ["imported", "x"] });
    // Arabic semicolon is not a separator: "vip؛gold" stays one tag
    expect(calls.some((c) => c.add.includes("vip؛gold"))).toBe(true);
  });

  it("updates matched contacts only with mapped, non-empty values when updateExisting is on", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", {
      id: "c1", workspaceId: "ws1", name: "Old Name", phone: "+971501234567", email: "old@x.com", tags: "[]", source: "web",
    });
    seedJob(prisma, { options: { matchBy: "phone_then_email", updateExisting: true } });
    const { runner } = makeRunner(prisma, csv("New Name,0501234567,"));
    await runner.run("job-seed");
    expect(prisma.contacts.get("c1")).toMatchObject({ name: "New Name", email: "old@x.com", source: "web" });
    expect(prisma.jobs.get("job-seed")).toMatchObject({ created: 0, updated: 1 });
  });

  it("updateExisting=false leaves matched contacts alone and counts them skipped", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "Keep", phone: "+971501234567", email: null, tags: "[]" });
    seedJob(prisma);
    const { runner } = makeRunner(prisma, csv("Changed,0501234567,"));
    await runner.run("job-seed");
    expect(prisma.contacts.get("c1")!.name).toBe("Keep");
    expect(prisma.jobs.get("job-seed")).toMatchObject({ skipped: 1, created: 0, updated: 0 });
  });

  it("merges in-file duplicates (first wins) and counts them", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma);
    const { runner } = makeRunner(prisma, csv("First,0501234567,", "Second,+971501234567,", "Third,,"));
    await runner.run("job-seed");
    expect([...prisma.contacts.values()].map((c) => c.name).sort()).toEqual(["First", "Third"]);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ created: 2, duplicateInFile: 1, failed: 0 });
  });

  it("audience kind creates a manual group once and adds new and matched contacts", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "Known", phone: "+971501234567", email: null, tags: "[]" });
    seedJob(prisma, { kind: "audience", options: { matchBy: "phone_then_email", updateExisting: false, newGroupName: "Spring list" } });
    const { runner, outbound } = makeRunner(prisma, csv("Known,0501234567,", "Fresh,0509999999,"));
    await runner.run("job-seed");
    const seg = [...prisma.segments.values()];
    expect(seg).toHaveLength(1);
    expect(seg[0]).toMatchObject({ name: "Spring list", origin: "manual", workspaceId: "ws1" });
    const memberIds = prisma.members.filter((m) => m.segmentId === seg[0].id).map((m) => m.contactId);
    expect(memberIds).toHaveLength(2);
    expect(memberIds).toContain("c1");
    expect(prisma.jobs.get("job-seed").options.groupId).toBe(seg[0].id);
    expect(outbound.emitSegmentUpserted).toHaveBeenCalled();
  });

  it("places created contacts in the pipeline through the bulk addToPipeline op", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { options: { matchBy: "phone", updateExisting: false, pipeline: { pipelineId: "p1", stageId: "s1" } } });
    const { runner, bulk } = makeRunner(prisma, csv(...rows(3)));
    await runner.run("job-seed");
    expect(bulk.run).toHaveBeenCalledTimes(1);
    const [ws, dto] = bulk.run.mock.calls[0];
    expect(ws).toBe("ws1");
    expect(dto).toMatchObject({ op: "addToPipeline", pipelineId: "p1", stageId: "s1" });
    expect(dto.ids).toHaveLength(3);
  });

  it("cancel stops the runner at the next batch", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { totalRows: 1500 });
    const { runner, notifications } = makeRunner(prisma, csv(...rows(1500)));
    // cancel as soon as the first batch has been persisted
    let first = true;
    prisma.onJobUpdate = (d: any) => {
      if (first && d.processed === 500) {
        first = false;
        prisma.jobs.get("job-seed").status = "cancelled";
      }
    };
    await runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.status).toBe("cancelled");
    expect(j.processed).toBe(500);
    expect(prisma.contacts.size).toBe(500);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("a failing runner marks the job failed", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma);
    const { runner, media } = makeRunner(prisma, csv("A,0501,"));
    media.readBuffer.mockRejectedValue(new Error("storage down"));
    await runner.run("job-seed");
    expect(prisma.jobs.get("job-seed").status).toBe("failed");
  });

  // Review Focus 4: exactly-once resume via deterministic per-row contact ids.
  it("resumes after a crash right after createMany without duplicating, and re-applies tags, custom values and group", async () => {
    const prisma = new FakePrisma();
    prisma.defs = [{ id: "dAge", key: "age", label: "Age", labelAr: "العمر", type: "number", options: null }];
    seedJob(prisma, {
      kind: "audience",
      mapping: { Name: "name", Phone: "phone", Tags: "tags", Age: "custom:dAge" },
      options: { matchBy: "phone_then_email", updateExisting: false, newGroupName: "G", tags: ["imp"] },
    });
    const file = "Name,Phone,Tags,Age\nA,0501000001,vip,30\nNameOnly,,vip,31\nC,0501000003,,32";
    const first = makeRunner(prisma, file);
    // crash: tag assignment throws after createMany already wrote the contacts
    first.tags.assign.mockRejectedValueOnce(new Error("process died"));
    await first.runner.run("job-seed");
    expect(prisma.contacts.size).toBe(3);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "failed", processed: 0 });

    // restart: the scheduler finds it running with processed=0
    Object.assign(prisma.jobs.get("job-seed"), { status: "running", finishedAt: null, heartbeatAt: new Date(Date.now() - 600_000) });
    const second = makeRunner(prisma, file);
    await second.runner.run("job-seed");

    expect(prisma.contacts.size).toBe(3); // no duplicates, name-only row included
    expect([...prisma.contacts.values()].map((c) => c.name).sort()).toEqual(["A", "C", "NameOnly"]);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "done", created: 3, updated: 0, skipped: 0 });
    expect(prisma.customValues).toHaveLength(3);
    const tagged = second.tags.assign.mock.calls.flatMap(([, i]) => i.contactIds);
    expect(new Set(tagged).size).toBe(3);
    expect([...prisma.segments.values()]).toHaveLength(1);
    expect(prisma.members).toHaveLength(3);
  });

  it("resumes from the stored offset and only creates the unprocessed tail", async () => {
    const prisma = new FakePrisma();
    const all = rows(1500);
    seedJob(prisma, { totalRows: 1500 });
    const first = makeRunner(prisma, csv(...all.slice(0, 1000)));
    await first.runner.run("job-seed");
    expect(prisma.contacts.size).toBe(1000);
    // crash image: processed=1000, stale heartbeat; stored file has all 1500 rows
    Object.assign(prisma.jobs.get("job-seed"), {
      status: "running", processed: 1000, created: 1000, totalRows: 1500, finishedAt: null,
      heartbeatAt: new Date(Date.now() - 600_000),
    });
    const second = makeRunner(prisma, csv(...all));
    const createMany = jest.spyOn(prisma.contact, "createMany");
    await second.runner.run("job-seed");
    expect(prisma.contacts.size).toBe(1500);
    expect(createMany.mock.calls.flatMap(([a]: any) => a.data)).toHaveLength(500);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "done", processed: 1500, created: 1500 });
  });

  it("a half-written batch is recognised by deterministic ids, not by phone/email", async () => {
    const prisma = new FakePrisma();
    const all = rows(600);
    seedJob(prisma, { totalRows: 500 });
    await makeRunner(prisma, csv(...all.slice(0, 500))).runner.run("job-seed");
    Object.assign(prisma.jobs.get("job-seed"), { status: "running", processed: 0, created: 0, finishedAt: null });
    await makeRunner(prisma, csv(...all)).runner.run("job-seed");
    expect(prisma.contacts.size).toBe(600);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ created: 600, skipped: 0, updated: 0 });
  });

  it("options.ownerId applies to created contacts only, not to updated ones", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "E", phone: "+971501234567", email: null, tags: "[]", ownerId: "u1" });
    seedJob(prisma, { options: { matchBy: "phone", updateExisting: true, ownerId: "u2" } });
    await makeRunner(prisma, csv("E2,0501234567,", "F,0507654321,")).runner.run("job-seed");
    expect(prisma.contacts.get("c1")!.ownerId).toBe("u1");
    expect([...prisma.contacts.values()].find((c) => c.name === "F")!.ownerId).toBe("u2");
  });

  it("deletes the stored upload when the job finishes", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma);
    const { runner, media } = makeRunner(prisma, csv("A,0501234567,"));
    await runner.run("job-seed");
    expect(media.remove).toHaveBeenCalledWith("ws1", "m1");
  });

  it("lease fencing: a runner whose job was re-claimed stops, then the new runner finishes without duplicates", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { totalRows: 1500 });
    const a = makeRunner(prisma, csv(...rows(1500)));
    // the scheduler re-claims the job (fresh heartbeat) after A's first progress write
    let claimed = false;
    prisma.onJobUpdate = (d: any) => {
      if (!claimed && d.processed === 500) {
        claimed = true;
        prisma.jobs.get("job-seed").heartbeatAt = new Date(Date.now() + 1_000_000);
      }
    };
    await a.runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.processed).toBe(500); // A stopped at its next batch start
    expect(j.status).toBe("running");
    expect(a.notifications.notify).not.toHaveBeenCalled();

    prisma.onJobUpdate = undefined;
    const b = makeRunner(prisma, csv(...rows(1500)));
    await b.runner.run("job-seed");
    expect(prisma.contacts.size).toBe(1500);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "done", created: 1500 });
  });
});

describe("ImportResumeScheduler", () => {
  it("re-kicks only running jobs with a heartbeat older than 2 minutes, once", async () => {
    const prisma = new FakePrisma();
    const now = new Date("2026-11-10T12:00:00Z");
    seedJob(prisma, { id: "stale", heartbeatAt: new Date(now.getTime() - 3 * 60_000) });
    seedJob(prisma, { id: "fresh", heartbeatAt: new Date(now.getTime() - 30_000) });
    seedJob(prisma, { id: "done", status: "done", heartbeatAt: new Date(now.getTime() - 10 * 60_000) });
    const { runner, media } = makeRunner(prisma, csv());
    const kick = jest.spyOn(runner, "kick").mockImplementation(() => undefined);
    const sched = new ImportResumeScheduler(prisma as never, runner, media as never);
    expect(await sched.sweep(now)).toBe(1);
    expect(kick).toHaveBeenCalledWith("stale");
    // heartbeat was claimed, so an immediate second sweep does nothing
    expect(await sched.sweep(now)).toBe(0);
  });
});
