import { FakePrisma, makeRunner, seedJob } from "./imports-test-fakes";
import { ImportResumeScheduler } from "./import-resume.scheduler";
import { suggestMapping } from "./suggest-mapping";
import { ImportsController } from "./imports.controller";
import { makeService } from "./imports-test-fakes";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const csv = (...lines: string[]) => ["Name,Phone,Email", ...lines].join("\n");
const stored = (id: string, phone: string | null, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  name: "Stored",
  phone,
  email: null,
  tags: "[]",
  ...over,
});

describe("phone matching against stored forms", () => {
  const cases: [string, string | null, string, string][] = [
    ["bare digits, no default country code", "971501234567", "Europe/London", "+971501234567"],
    ["bare digits, other default country code", "971501234567", "Asia/Riyadh", "+971501234567"],
    ["spaced international form", "+971 50 123 4567", "Asia/Dubai", "0501234567"],
    ["local form with dashes", "050-123-4567", "Asia/Dubai", "0501234567"],
  ];
  it.each(cases)("%s is matched, not duplicated", async (_n, storedPhone, tz, filePhone) => {
    const prisma = new FakePrisma();
    prisma.timezone = tz;
    prisma.contacts.set("c1", stored("c1", storedPhone));
    seedJob(prisma);
    await makeRunner(prisma, csv(`New,${filePhone},`)).runner.run("job-seed");
    expect(prisma.contacts.size).toBe(1);
    expect(prisma.jobs.get("job-seed")).toMatchObject({ created: 0, skipped: 1 });
  });
});

describe("update path keeps stored name parts", () => {
  const existing = () =>
    stored("c1", "+971501234567", { name: "Ahmed Ali", firstName: "Ahmed", lastName: "Ali" });

  it("a firstName-only mapping keeps the stored last name", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", existing());
    seedJob(prisma, { mapping: { First: "firstName", Phone: "phone" }, options: { matchBy: "phone", updateExisting: true } });
    await makeRunner(prisma, "First,Phone\nKhaled,0501234567").runner.run("job-seed");
    expect(prisma.contacts.get("c1")).toMatchObject({ name: "Khaled Ali", firstName: "Khaled", lastName: "Ali" });
  });

  it("an empty last-name cell keeps the stored last name", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c1", existing());
    seedJob(prisma, {
      mapping: { First: "firstName", Last: "lastName", Phone: "phone" },
      options: { matchBy: "phone", updateExisting: true },
    });
    await makeRunner(prisma, "First,Last,Phone\nKhaled,,0501234567").runner.run("job-seed");
    expect(prisma.contacts.get("c1")).toMatchObject({ name: "Khaled Ali", lastName: "Ali" });
  });

  it("derives parts from name when the stored parts are stale, and a name column still replaces the whole name", async () => {
    const prisma = new FakePrisma();
    prisma.contacts.set("c2", existing());
    Object.assign(prisma.contacts.get("c2")!, { id: "c2", phone: "+971507654321" });
    seedJob(prisma, { options: { matchBy: "phone", updateExisting: true } });
    await makeRunner(prisma, csv("Zed,0507654321,")).runner.run("job-seed");
    expect(prisma.contacts.get("c2")).toMatchObject({ name: "Zed", firstName: "Zed", lastName: null });

    const p2 = new FakePrisma();
    p2.contacts.set("c1", stored("c1", "+971501234567", { name: "Sara Noor", firstName: null, lastName: null }));
    seedJob(p2, { mapping: { First: "firstName", Phone: "phone" }, options: { matchBy: "phone", updateExisting: true } });
    await makeRunner(p2, "First,Phone\nLina,0501234567").runner.run("job-seed");
    expect(p2.contacts.get("c1")).toMatchObject({ name: "Lina Noor", firstName: "Lina", lastName: "Noor" });
  });
});

describe("owner by name", () => {
  it("is owner_ambiguous when several members share the name", async () => {
    const prisma = new FakePrisma();
    prisma.workspaceMembers.push({ userId: "u3", user: { id: "u3", name: "agent two", email: "other@x.com" } });
    seedJob(prisma, { mapping: { Name: "name", Phone: "phone", Owner: "owner" } });
    const file = "Name,Phone,Owner\nA,0501000001,Agent Two\nB,0501000002,Owner One\nC,0501000003,other@x.com";
    await makeRunner(prisma, file).runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.failed).toBe(1);
    expect(j.errors).toEqual([{ row: 2, column: "Owner", key: "imports.err.owner_ambiguous" }]);
    expect([...prisma.contacts.values()].map((c) => c.ownerId).sort()).toEqual(["u1", "u3"]);
  });
});

describe("group and tag options reach matched contacts", () => {
  it("a contacts import adds unchanged contacts to the group and tags them", async () => {
    const prisma = new FakePrisma();
    prisma.segments.set("g1", { id: "g1", workspaceId: "ws1", origin: "manual" });
    prisma.contacts.set("c1", stored("c1", "+971501234567"));
    seedJob(prisma, { options: { matchBy: "phone", updateExisting: false, groupId: "g1", tags: ["spring"] } });
    const { runner, tags } = makeRunner(prisma, csv("Same,0501234567,", "Fresh,0509999999,"));
    await runner.run("job-seed");
    expect(prisma.members.map((m) => m.contactId)).toContain("c1");
    expect(prisma.members).toHaveLength(2);
    const tagged = tags.assign.mock.calls.flatMap(([, i]) => i.contactIds);
    expect(tagged).toContain("c1");
    expect(prisma.jobs.get("job-seed")).toMatchObject({ skipped: 1, created: 1 });
  });
});

describe("HJZ push volume", () => {
  it("emits segment-upserted once for a multi-batch audience import", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { kind: "audience", options: { matchBy: "phone", updateExisting: false, newGroupName: "Big" } });
    const lines = Array.from({ length: 1200 }, (_, i) => `P${i},05022${String(i).padStart(5, "0")},`);
    const { runner, outbound } = makeRunner(prisma, csv(...lines));
    await runner.run("job-seed");
    expect(prisma.members).toHaveLength(1200);
    expect(outbound.emitSegmentUpserted).toHaveBeenCalledTimes(1);
  });
});

describe("failed jobs", () => {
  it("store a failure reason and notify the creator", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { errors: [{ row: 5, column: "Email", key: "imports.err.bad_email" }] });
    const { runner, media, notifications } = makeRunner(prisma, csv("A,0501,"));
    media.readBuffer.mockRejectedValue(new Error("storage down"));
    await runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.status).toBe("failed");
    expect(j.errors[0]).toEqual({ row: 0, column: null, key: "imports.err.job_failed" });
    expect(j.errors[1]).toMatchObject({ row: 5 });
    expect(notifications.notify).toHaveBeenCalledWith("ws1", ["u1"], expect.objectContaining({ title: "import.failed" }));
    expect(media.remove).toHaveBeenCalled();
  });

  it("transient database errors leave the job running for resume, up to 3 attempts", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma);
    const { runner, media, notifications } = makeRunner(prisma, csv("A,0501234567,"));
    media.readBuffer.mockRejectedValue(Object.assign(new Error("Cannot reach database server"), { code: "P1001" }));
    await runner.run("job-seed");
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "running", options: { attempts: 1 } });
    await runner.run("job-seed");
    expect(prisma.jobs.get("job-seed")).toMatchObject({ status: "running", options: { attempts: 2 } });
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(media.remove).not.toHaveBeenCalled();
    await runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.status).toBe("failed");
    expect(j.errors[0].key).toBe("imports.err.job_failed");
    expect(notifications.notify).toHaveBeenCalledTimes(1);
  });
});

describe("cancel races", () => {
  it("persists the counters of a batch that finished after the job was cancelled", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { totalRows: 1500 });
    const lines = Array.from({ length: 1500 }, (_, i) => `P${i},05033${String(i).padStart(5, "0")},`);
    const { runner } = makeRunner(prisma, csv(...lines));
    let n = 0;
    prisma.onJobUpdate = () => {
      // cancel right after the first batch-start gate, before the progress write
      if (++n === 1) prisma.jobs.get("job-seed").status = "cancelled";
    };
    await runner.run("job-seed");
    const j = prisma.jobs.get("job-seed");
    expect(j.status).toBe("cancelled");
    expect(j).toMatchObject({ processed: 500, created: 500 });
    expect(prisma.contacts.size).toBe(500);
  });

  it("does not create the audience group when the job is cancelled before the first gate", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { kind: "audience", options: { matchBy: "phone", updateExisting: false, newGroupName: "G" } });
    const { runner, media, outbound } = makeRunner(prisma, csv("A,0501234567,"));
    media.readBuffer.mockImplementation(async () => {
      prisma.jobs.get("job-seed").status = "cancelled"; // cancelled while the file is read
      return Buffer.from(csv("A,0501234567,"));
    });
    await runner.run("job-seed");
    expect(prisma.segments.size).toBe(0);
    expect(prisma.contacts.size).toBe(0);
    expect(outbound.emitSegmentUpserted).not.toHaveBeenCalled();
  });
});

describe("abandoned uploads", () => {
  it("cancels uploaded/previewed jobs older than 24 h and removes their files", async () => {
    const prisma = new FakePrisma();
    const now = new Date("2026-11-10T12:00:00Z");
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    seedJob(prisma, { id: "u-old", status: "uploaded", createdAt: ago(25), fileMediaId: "m-u" });
    seedJob(prisma, { id: "p-old", status: "previewed", createdAt: ago(30), fileMediaId: "m-p" });
    seedJob(prisma, { id: "u-new", status: "uploaded", createdAt: ago(1), fileMediaId: "m-n" });
    seedJob(prisma, { id: "r-old", status: "running", createdAt: ago(48), fileMediaId: "m-r" });
    const { runner, media } = makeRunner(prisma, csv());
    const sched = new ImportResumeScheduler(prisma as never, runner, media as never);
    expect(await sched.sweepAbandoned(now)).toBe(2);
    expect(prisma.jobs.get("u-old")).toMatchObject({ status: "cancelled", finishedAt: now });
    expect(prisma.jobs.get("p-old").status).toBe("cancelled");
    expect(prisma.jobs.get("u-new").status).toBe("uploaded");
    expect(prisma.jobs.get("r-old").status).toBe("running");
    expect(media.remove.mock.calls.map((c) => c[1]).sort()).toEqual(["m-p", "m-u"]);
  });

  it("is fenced by status: a job that started running meanwhile is left alone", async () => {
    const prisma = new FakePrisma();
    const now = new Date("2026-11-10T12:00:00Z");
    seedJob(prisma, { id: "u-old", status: "uploaded", createdAt: new Date(now.getTime() - 25 * 3_600_000) });
    const { runner, media } = makeRunner(prisma, csv());
    const sched = new ImportResumeScheduler(prisma as never, runner, media as never);
    const find = prisma.importJob.findMany;
    prisma.importJob.findMany = (async (a: unknown) => {
      const rows = await (find as any)(a);
      prisma.jobs.get("u-old").status = "running"; // run clicked right after the sweep read it
      return rows;
    }) as never;
    expect(await sched.sweepAbandoned(now)).toBe(0);
    expect(prisma.jobs.get("u-old").status).toBe("running");
    expect(media.remove).not.toHaveBeenCalled();
  });
});

describe("suggestMapping with exported headers", () => {
  const defs = [
    { id: "d1", key: "nm", label: "Name", labelAr: "", type: "text", options: null },
    { id: "d2", key: "budget", label: "Budget", labelAr: "", type: "number", options: null },
  ];
  it("maps `Label (key)` to the custom field and keeps plain base names on the base target", () => {
    const m = suggestMapping(["Name", "Name (nm)", "Budget", "value", "Phone"], defs);
    expect(m).toEqual({ Name: "name", "Name (nm)": "custom:d1", Budget: "custom:d2", value: "value", Phone: "phone" });
  });
});

describe("upload temp file", () => {
  it("is removed even when the kind is missing or invalid", async () => {
    const { svc } = makeService(new FakePrisma(), csv("A,0501234567,"));
    const ctrl = new ImportsController(svc);
    for (const body of [{}, { kind: "bogus" }]) {
      const path = join(tmpdir(), `imp-test-${Math.random().toString(36).slice(2)}.csv`);
      await writeFile(path, csv("A,0501234567,"));
      const file = { path, originalname: "a.csv" } as Express.Multer.File;
      await expect(ctrl.create("ws1", { userId: "u1" } as never, body, file)).rejects.toMatchObject({
        response: { messageKey: "imports.invalid_kind" },
      });
      expect(existsSync(path)).toBe(false);
    }
  });
});
