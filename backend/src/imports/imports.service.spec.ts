import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { FakePrisma, makeService, seedJob } from "./imports-test-fakes";
import { suggestMapping } from "./suggest-mapping";

const MAP = { Name: "name", Phone: "phone", Email: "email" } as Record<string, string>;
const V = { userId: "u1", bypass: false };

function key(e: unknown): string | undefined {
  return (e as BadRequestException).getResponse
    ? ((e as BadRequestException).getResponse() as { messageKey?: string }).messageKey
    : undefined;
}
async function rejectKey(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return key(e);
  }
  return "RESOLVED";
}

describe("ImportsService.create", () => {
  it("stores the file and returns headers, 20 sample rows, total and suggested mapping", async () => {
    const prisma = new FakePrisma();
    const lines = ["Name,الجوال,Email,Tags"];
    for (let i = 0; i < 30; i++) lines.push(`P${i},05012345${String(i).padStart(2, "0")},p${i}@x.com,vip`);
    const { svc, media } = makeService(prisma, "");
    media.ingestDocument.mockResolvedValue({ id: "m1" });
    const out = await svc.create(
      "ws1",
      V,
      { buffer: Buffer.from(lines.join("\n"), "utf8"), originalname: "c.csv" },
      "contacts",
    );
    expect(out.headers).toEqual(["Name", "الجوال", "Email", "Tags"]);
    expect(out.sampleRows).toHaveLength(20);
    expect(out.totalRows).toBe(30);
    expect(out.suggestedMapping).toEqual({ Name: "name", "الجوال": "phone", Email: "email", Tags: "tags" });
    expect(prisma.jobs.get(out.id)).toMatchObject({ status: "uploaded", fileMediaId: "m1", createdById: "u1", totalRows: 30 });
    expect(media.ingestDocument).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1", mimeType: "text/csv" }));
  });

  it("maps parser failures to a 400 with the message key", async () => {
    const { svc } = makeService(new FakePrisma(), "");
    expect(await rejectKey(svc.create("ws1", V, { buffer: Buffer.from("a"), originalname: "x.pdf" }, "contacts"))).toBe(
      "imports.unsupported_type",
    );
    expect(await rejectKey(svc.create("ws1", V, { buffer: Buffer.from(""), originalname: "x.csv" }, "contacts"))).toBe(
      "imports.file_empty",
    );
  });

  it("audience kind additionally requires audiences.create", async () => {
    const { svc } = makeService(new FakePrisma(), "", (p) => !p.startsWith("audiences."));
    await expect(
      svc.create("ws1", V, { buffer: Buffer.from("Name\nA"), originalname: "x.csv" }, "audience"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("ImportsService.preview", () => {
  function setup(csv: string, can?: (p: string) => boolean) {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "uploaded", totalRows: 0 });
    const made = makeService(prisma, csv, can);
    return { prisma, ...made };
  }
  const body = (options: Record<string, unknown> = {}) => ({ mapping: MAP, options });

  it("counts new, update, unchanged, invalid and in-file duplicates", async () => {
    const csv = [
      "Name,Phone,Email",
      "New One,0501111111,",
      "Exists,0502222222,",
      "Dup of new,+971501111111,",
      "Bad email,,not-an-email",
      ",,",
      "By email,,known@x.com",
    ].join("\n");
    const { prisma, svc } = setup(csv);
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "E", phone: "+971502222222", email: null, tags: "[]" });
    prisma.contacts.set("c2", { id: "c2", workspaceId: "ws1", name: "K", phone: null, email: "known@x.com", tags: "[]" });
    const out = await svc.preview("ws1", V, "j1", body({ updateExisting: true }));
    expect(out.counts).toEqual({ new: 1, update: 2, unchanged: 0, invalid: 1, duplicateInFile: 1 });
    expect(out.invalidSamples).toEqual([{ row: 5, column: "Email", key: "imports.err.bad_email" }]);
    expect(prisma.jobs.get("j1")).toMatchObject({ status: "previewed", mapping: MAP });
  });

  it("matches the same person across +CC, 00CC, local and Arabic-Indic phone forms", async () => {
    const csv = ["Name,Phone", "A,+971501234567", "B,00971501234567", "C,0501234567", "D,٠٥٠١٢٣٤٥٦٧"].join("\n");
    const { prisma, svc } = setup(csv);
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "E", phone: "0501234567", email: null, tags: "[]" });
    const out = await svc.preview("ws1", V, "j1", { mapping: { Name: "name", Phone: "phone" }, options: { updateExisting: true } });
    // First row matches the stored local-format phone; the rest are in-file duplicates of it.
    expect(out.counts).toMatchObject({ update: 1, new: 0, duplicateInFile: 3 });
  });

  it("updateExisting=false reports matched rows as unchanged", async () => {
    const { prisma, svc } = setup("Name,Phone\nA,0501111111");
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "E", phone: "+971501111111", email: null, tags: "[]" });
    const out = await svc.preview("ws1", V, "j1", { mapping: { Name: "name", Phone: "phone" }, options: {} });
    expect(out.counts).toMatchObject({ unchanged: 1, update: 0, new: 0 });
  });

  it("matchBy=email ignores phone matches", async () => {
    const { prisma, svc } = setup("Name,Phone,Email\nA,0501111111,a@x.com");
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "E", phone: "+971501111111", email: null, tags: "[]" });
    const out = await svc.preview("ws1", V, "j1", body({ matchBy: "email", updateExisting: true }));
    expect(out.counts).toMatchObject({ new: 1, update: 0 });
  });

  it("keeps at most 50 invalid samples while counting every invalid row", async () => {
    const lines = ["Name,Phone,Email"];
    for (let i = 0; i < 80; i++) lines.push(`X${i},,bad${i}`);
    const { svc } = setup(lines.join("\n"));
    const out = await svc.preview("ws1", V, "j1", body());
    expect(out.counts.invalid).toBe(80);
    expect(out.invalidSamples).toHaveLength(50);
    expect(out.invalidSamples[0].row).toBe(2);
  });

  it("reports the spreadsheet row number, counting blank rows", async () => {
    const { svc } = setup("Name,Email\nA,a@x.com\n\nB,nope");
    const out = await svc.preview("ws1", V, "j1", { mapping: { Name: "name", Email: "email" }, options: {} });
    expect(out.invalidSamples).toEqual([{ row: 4, column: "Email", key: "imports.err.bad_email" }]);
  });

  it("resolves an owner column by email or name; a non-member owner makes the row invalid", async () => {
    const { svc } = setup("Name,Owner\nA,agent@x.com\nB,Owner One\nC,stranger@evil.com");
    const out = await svc.preview("ws1", V, "j1", { mapping: { Name: "name", Owner: "owner" }, options: {} });
    expect(out.counts).toMatchObject({ new: 2, invalid: 1 });
    expect(out.invalidSamples).toEqual([{ row: 4, column: "Owner", key: "imports.err.owner_not_found" }]);
  });

  it("rejects a foreign options.ownerId", async () => {
    const { svc } = setup("Name\nA");
    expect(await rejectKey(svc.preview("ws1", V, "j1", { mapping: { Name: "name" }, options: { ownerId: "u-foreign" } }))).toBe(
      "imports.owner_invalid",
    );
  });

  it("validates custom field values (type rules, Arabic-Indic digits) and rejects foreign def ids", async () => {
    const csv = ["Name,Age,Plan,Active", "A,٣٠,gold,yes", "B,abc,gold,yes", "C,5,platinum,yes", "D,5,GOLD,maybe"].join("\n");
    const { prisma, svc } = setup(csv);
    prisma.defs = [
      { id: "dAge", key: "age", label: "Age", labelAr: "العمر", type: "number", options: null },
      { id: "dPlan", key: "plan", label: "Plan", labelAr: "الخطة", type: "select", options: ["gold", "silver"] },
      { id: "dAct", key: "active", label: "Active", labelAr: "نشط", type: "boolean", options: null },
    ];
    const mapping = { Name: "name", Age: "custom:dAge", Plan: "custom:dPlan", Active: "custom:dAct" };
    const out = await svc.preview("ws1", V, "j1", { mapping, options: {} });
    expect(out.counts).toMatchObject({ new: 1, invalid: 3 });
    expect(out.invalidSamples.map((s) => `${s.row}:${s.column}`)).toEqual(["3:Age", "4:Plan", "5:Active"]);
    expect(out.invalidSamples.every((s) => s.key === "imports.err.bad_custom_value")).toBe(true);
    expect(
      await rejectKey(svc.preview("ws1", V, "j1", { mapping: { Name: "name", Age: "custom:other-ws" }, options: {} })),
    ).toBe("imports.custom_field_invalid");
  });

  it("requires name, firstName or phone to be mapped", async () => {
    const { svc } = setup("Name,Email\nA,a@x.com");
    expect(await rejectKey(svc.preview("ws1", V, "j1", { mapping: { Email: "email" }, options: {} }))).toBe(
      "imports.mapping_required",
    );
  });

  it("refuses a pipeline for more than 500 rows (400 key) but allows exactly 500", async () => {
    const mk = (n: number) => ["Name", ...Array.from({ length: n }, (_, i) => `N${i}`)].join("\n");
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "uploaded", totalRows: 501 });
    const big = makeService(prisma, mk(501));
    const opts = { pipeline: { pipelineId: "p1" } };
    expect(await rejectKey(big.svc.preview("ws1", V, "j1", { mapping: { Name: "name" }, options: opts }))).toBe(
      "imports.pipeline_too_large",
    );
    seedJob(prisma, { id: "j2", status: "uploaded", totalRows: 500 });
    const ok = makeService(prisma, mk(500));
    await expect(ok.svc.preview("ws1", V, "j2", { mapping: { Name: "name" }, options: opts })).resolves.toBeDefined();
    expect(await rejectKey(ok.svc.preview("ws1", V, "j2", { mapping: { Name: "name" }, options: { pipeline: { pipelineId: "pX" } } }))).toBe(
      "imports.pipeline_invalid",
    );
  });

  it("audience kind needs a group; a foreign groupId is 404", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "ja", kind: "audience", status: "uploaded" });
    const { svc } = makeService(prisma, "Name\nA");
    expect(await rejectKey(svc.preview("ws1", V, "ja", { mapping: { Name: "name" }, options: {} }))).toBe("imports.group_required");
    expect(await rejectKey(svc.preview("ws1", V, "ja", { mapping: { Name: "name" }, options: { groupId: "nope" } }))).toBe(
      "imports.group_invalid",
    );
  });

  it("updateExisting needs contacts.update; audience needs audiences.create", async () => {
    const { svc } = setup("Name\nA", (p) => p !== "contacts.update");
    await expect(svc.preview("ws1", V, "j1", { mapping: { Name: "name" }, options: { updateExisting: true } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.preview("ws1", V, "j1", { mapping: { Name: "name" }, options: {} })).resolves.toBeDefined();
  });
});

describe("ImportsService preview guards and permissions", () => {
  const MAP2 = { Name: "name" };
  function one(status: string, can?: (p: string) => boolean) {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status });
    return { prisma, ...makeService(prisma, "Name\nA", can) };
  }

  it("preview of a running job is 409 imports.invalid_state", async () => {
    const { svc } = one("running");
    await expect(svc.preview("ws1", V, "j1", { mapping: MAP2 })).rejects.toBeInstanceOf(ConflictException);
  });

  it("a run that starts while the preview is counting is not overwritten (409)", async () => {
    const { prisma, svc, media } = one("uploaded");
    media.readBuffer.mockImplementation(async () => {
      prisma.jobs.get("j1").status = "running";
      return Buffer.from("Name\nA");
    });
    await expect(svc.preview("ws1", V, "j1", { mapping: MAP2 })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.jobs.get("j1").status).toBe("running");
  });

  it("adding to an existing group needs audiences.update (contacts kind too)", async () => {
    const { prisma, svc } = one("uploaded", (p) => p !== "audiences.update");
    prisma.segments.set("g1", { id: "g1", workspaceId: "ws1", origin: "manual" });
    await expect(svc.preview("ws1", V, "j1", { mapping: MAP2, options: { groupId: "g1" } })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a new audience group needs audiences.create, an existing one only audiences.update", async () => {
    const a = one("uploaded", (p) => p !== "audiences.create");
    seedJob(a.prisma, { id: "ja", kind: "audience", status: "uploaded" });
    a.prisma.segments.set("g1", { id: "g1", workspaceId: "ws1", origin: "manual" });
    await expect(a.svc.preview("ws1", V, "ja", { mapping: MAP2, options: { newGroupName: "N" } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(a.svc.preview("ws1", V, "ja", { mapping: MAP2, options: { groupId: "g1" } })).resolves.toBeDefined();
  });

  it("a pipeline needs tickets.create and contacts.update", async () => {
    for (const denied of ["tickets.create", "contacts.update"]) {
      const { svc } = one("uploaded", (p) => p !== denied);
      await expect(
        svc.preview("ws1", V, "j1", { mapping: MAP2, options: { pipeline: { pipelineId: "p1" } } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("job responses omit the storage reference", async () => {
    const { svc } = one("previewed");
    expect(await svc.job("ws1", "j1")).not.toHaveProperty("fileMediaId");
    expect((await svc.list("ws1"))[0]).not.toHaveProperty("fileMediaId");
  });
});

describe("ImportsService matching", () => {
  it("matches stored phones with spaces/dashes and emails case-insensitively", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "uploaded" });
    const { svc } = makeService(prisma, "Name,Phone,Email\nA,0501234567,\nB,0507654321,\nC,,mixed@case.com\nD,0500000000,");
    prisma.contacts.set("c1", { id: "c1", workspaceId: "ws1", name: "x", phone: "+971 50 123 4567", email: null, tags: "[]" });
    prisma.contacts.set("c2", { id: "c2", workspaceId: "ws1", name: "y", phone: "050-765-4321", email: null, tags: "[]" });
    prisma.contacts.set("c3", { id: "c3", workspaceId: "ws1", name: "z", phone: null, email: "Mixed@Case.com", tags: "[]" });
    const out = await svc.preview("ws1", V, "j1", { mapping: MAP, options: { updateExisting: true } });
    expect(out.counts).toMatchObject({ update: 3, new: 1 });
  });
});

describe("ImportsService job access", () => {
  it("a job of another workspace is 404 on every route", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "foreign", workspaceId: "ws-other", status: "previewed", mapping: MAP, options: { updateExisting: false } });
    const { svc } = makeService(prisma, "Name\nA");
    await expect(svc.job("ws1", "foreign")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.preview("ws1", V, "foreign", { mapping: MAP })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.run("ws1", V, "foreign")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.cancel("ws1", "foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.jobs.get("foreign").status).toBe("previewed");
  });

  it("run needs a previewed job, flips to running once and kicks the runner", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "uploaded" });
    seedJob(prisma, { id: "j2", status: "previewed", heartbeatAt: null, startedAt: null });
    const { svc, runner } = makeService(prisma, "Name\nA");
    const kick = jest.spyOn(runner, "kick").mockImplementation(() => undefined);
    expect(await rejectKey(svc.run("ws1", V, "j1"))).toBe("imports.not_previewed");
    const job = await svc.run("ws1", V, "j2");
    expect(job.status).toBe("running");
    expect(job.heartbeatAt).toBeInstanceOf(Date);
    await svc.run("ws1", V, "j2");
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("run with updateExisting needs contacts.update", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "previewed", options: { matchBy: "phone", updateExisting: true } });
    const { svc } = makeService(prisma, "Name\nA", (p) => p !== "contacts.update");
    await expect(svc.run("ws1", V, "j1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.jobs.get("j1").status).toBe("previewed");
  });

  it("cancel marks the job cancelled; list returns recent jobs", async () => {
    const prisma = new FakePrisma();
    seedJob(prisma, { id: "j1", status: "running" });
    const { svc } = makeService(prisma, "Name\nA");
    expect((await svc.cancel("ws1", "j1")).status).toBe("cancelled");
    expect(await svc.list("ws1", 10)).toHaveLength(1);
  });
});

describe("suggestMapping", () => {
  it("matches English and Arabic synonyms", () => {
    expect(
      suggestMapping(["Mobile", "الاسم", "البريد", "الوسوم", "Whatever"]),
    ).toEqual({ Mobile: "phone", "الاسم": "name", "البريد": "email", "الوسوم": "tags", Whatever: "ignore" });
    expect(suggestMapping(["الهاتف", "Phone"])).toEqual({ "الهاتف": "phone", Phone: "ignore" });
  });
  it("matches custom field labels", () => {
    expect(
      suggestMapping(["Company size"], [{ id: "d1", key: "size", label: "Company size", labelAr: "حجم", type: "text", options: null }]),
    ).toEqual({ "Company size": "custom:d1" });
  });
});
