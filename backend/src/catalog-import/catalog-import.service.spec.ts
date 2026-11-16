/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from "@nestjs/common";
import { TEMPLATE_HEADERS, buildTemplate, matchTemplate, parseDayCell } from "./templates";
import { A, B, csv, failure, fakeExtractor, importWorld, xlsx } from "./catalog-import-test-world";
import * as ExcelJS from "exceljs";

const SVC_HEADERS = TEMPLATE_HEADERS.services;
const STAFF_HEADERS = TEMPLATE_HEADERS.staff;

describe("template file imports without ai", () => {
  it("the services template with 3 rows → extractedBy template, no extractor call, review items exact", async () => {
    const w = importWorld();
    const file = await xlsx([
      SVC_HEADERS,
      ["Haircut", "قص الشعر", 45, "80", "SAR", "Wash and cut"],
      ["Beard trim", "", "", "", "", ""],
      ["Colour", "صبغة", 120, "250.5", "aed", ""],
    ]);
    const dto = await w.svc.create(A, "uOwner", { kind: "auto", file });
    expect(w.extractor.extract).not.toHaveBeenCalled();
    expect(w.svc.kickExtraction).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ source: "file", kind: "services", status: "review", extractedBy: "template", fileName: "catalog.xlsx", total: 3 });
    expect(dto.items).toEqual([
      {
        key: "s1",
        kind: "service",
        data: { name: "Haircut", nameAr: "قص الشعر", durationMin: 45, durationDefaulted: false, price: "80.00", currency: "SAR", description: "Wash and cut" },
        duplicateOf: null,
        selected: true,
      },
      {
        key: "s2",
        kind: "service",
        data: { name: "Beard trim", nameAr: "Beard trim", durationMin: 60, durationDefaulted: true, price: null, currency: null, description: null },
        duplicateOf: null,
        selected: true,
      },
      {
        key: "s3",
        kind: "service",
        data: { name: "Colour", nameAr: "صبغة", durationMin: 120, durationDefaulted: false, price: "250.50", currency: "AED", description: null },
        duplicateOf: null,
        selected: true,
      },
    ]);
    expect(dto).not.toHaveProperty("inputText");
  });

  it("the staff template's day cells are parsed and validated; a bad cell is an item error, not a failure", async () => {
    const w = importWorld();
    const file = csv([
      STAFF_HEADERS,
      ["Sara", "سارة", "Stylist", "Haircut, Beard trim", "09:00-13:00, 16:00-21:00", "9:00-17:00", "", "", "off", "عطلة", "10:00-14:00"],
      ["Lina", "", "", "", "nine to five", "", "", "", "", "", ""],
      ["Omar", "", "", "", "17:00-09:00", "", "", "", "", "", ""],
    ]);
    const dto = await w.svc.create(A, "uOwner", { file });
    expect(dto).toMatchObject({ status: "review", kind: "staff", extractedBy: "template" });
    const [sara, lina, omar] = dto.items!;
    expect(sara).toMatchObject({
      selected: true,
      data: {
        name: "Sara",
        nameAr: "سارة",
        role: "Stylist",
        services: ["Haircut", "Beard trim"],
        schedule: {
          mon: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }],
          tue: [{ from: "09:00", to: "17:00" }],
          sun: [{ from: "10:00", to: "14:00" }],
        },
      },
    });
    expect(sara).not.toHaveProperty("error");
    expect(lina).toMatchObject({ selected: false, error: { field: "schedule" } });
    expect(omar).toMatchObject({ selected: false, error: { field: "schedule" } });
  });

  it("matchTemplate is exact (case/space-insensitive); other files go to AI; the downloadable templates match", async () => {
    expect(matchTemplate(["name", " Name (Arabic) ", "DURATION (MINUTES)", "Price", "Currency", "Description", ""])).toBe("services");
    expect(matchTemplate(["Name", "Price"])).toBeNull();
    for (const kind of ["services", "staff"] as const) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await buildTemplate(kind)) as any);
      const header = (wb.worksheets[0].getRow(1).values as any[]).slice(1).map(String);
      expect(matchTemplate(header)).toBe(kind);
      expect(wb.worksheets[0].getRow(1).getCell(1).note).toBeTruthy(); // bilingual notes
      expect(wb.worksheets[0].rowCount).toBe(2); // one example row
    }
    expect(parseDayCell("09:00-13:00، 16:00–21:00")).toEqual([{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }]);
    expect(parseDayCell("closed")).toEqual([]);
    expect(parseDayCell("all day")).toBeNull();

    const w = importWorld();
    const other = await w.svc.create(A, "uOwner", { file: csv([["Service", "Cost"], ["Haircut", "80"]]) });
    expect(other).toMatchObject({ status: "extracting", source: "file" });
    expect(w.svc.kickExtraction).toHaveBeenCalledWith(other.id);
    expect(w.prisma.db.catalogImport[0].inputText).toBe("Service: Haircut | Cost: 80");
  });

  it("file refusals: too many rows, not a spreadsheet, empty template", async () => {
    const w = importWorld();
    const rows = [SVC_HEADERS, ...Array.from({ length: 2001 }, (_, i) => [`S${i}`, "", "30", "", "", ""])];
    expect(await failure(w.svc.create(A, "uOwner", { file: csv(rows) }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "catalog_import.too_many_rows", max: 2000 },
    });
    expect((await failure(w.svc.create(A, "uOwner", { file: { buffer: Buffer.from("%PDF-1.4"), originalname: "menu.pdf" } }))).body.message).toBe(
      "catalog_import.file_invalid",
    );
    expect((await failure(w.svc.create(A, "uOwner", { file: csv([SVC_HEADERS]) }))).body.message).toBe("catalog_import.nothing_found");
  });
});

describe("duplicates start unchecked", () => {
  it("an existing service and a proposed one equal after normalization, and duplicates within the proposal", async () => {
    const extractor = fakeExtractor({
      lang: "mixed",
      services: [{ title: "قص  الشعر" }, { title: "haircut" }, { title: "Haircut" }, { title: "Shave" }, { title: "SHAVE " }],
      staff: [{ title: "Sara" }, { title: "أحمد" }],
    });
    const w = importWorld({ extractor });
    await w.services.create(A, { name: "Haircut", nameAr: "قص الشعر", durationMin: 30 });
    const sara = await w.staff.create(A, { name: "Sara" });
    // An archived row is not a duplicate target.
    const old = await w.staff.create(A, { name: "احمد" });
    w.prisma.db.staffResource.find((r: any) => r.id === old.id).archivedAt = new Date();

    const job = await w.svc.create(A, "uOwner", { source: "paste", text: "...", kind: "auto" });
    await w.svc.extract(job.id);
    const dto = await w.svc.get(A, job.id);
    const by = Object.fromEntries(dto.items!.map((i) => [i.key, i]));
    const svc = (await w.services.list(A)).items[0];
    expect(by.s1).toMatchObject({ duplicateOf: { id: svc.id, name: "Haircut" }, selected: false });
    expect(by.s2).toMatchObject({ duplicateOf: { id: svc.id }, selected: false });
    expect(by.s3).toMatchObject({ duplicateOf: { id: svc.id }, selected: false });
    expect(by.s4).toMatchObject({ duplicateOf: null, selected: true });
    expect(by.s5).toMatchObject({ duplicateOf: { id: null, key: "s4", name: "Shave" }, selected: false });
    expect(by.t1).toMatchObject({ duplicateOf: { id: sara.id }, selected: false });
    expect(by.t2).toMatchObject({ duplicateOf: null, selected: true });
  });
});

describe("extraction flows (paste, url) and failures", () => {
  it("paste: extracting → review; the input text is gone afterwards and never returned", async () => {
    const extractor = fakeExtractor({ lang: "en", services: [{ title: "Haircut", durationMinutes: 30 }], staff: [] });
    const w = importWorld({ extractor });
    const job = await w.svc.create(A, "uOwner", { source: "paste", text: "  Haircut 30 min  ", kind: "services" });
    expect(job).toMatchObject({ status: "extracting", source: "paste" });
    expect(job).not.toHaveProperty("items");
    expect(w.prisma.db.catalogImport[0].inputText).toBe("Haircut 30 min");
    await w.svc.extract(job.id);
    expect(extractor.extract).toHaveBeenCalledWith("Haircut 30 min", "services");
    const row = w.prisma.db.catalogImport[0];
    expect(row).toMatchObject({ status: "review", extractedBy: "ai", inputText: null, total: 1 });
    expect(JSON.stringify(await w.svc.get(A, job.id))).not.toContain("inputText");
  });

  it("url: the page fetcher gets the URL; its failure key becomes the job's errorKey", async () => {
    const extractor = fakeExtractor({ lang: "en", services: [{ title: "Cut" }], staff: [] });
    const w = importWorld({ extractor, page: async () => "Cut — 50 SAR" });
    const job = await w.svc.create(A, "uOwner", { source: "url", url: "https://salon.example/menu", kind: "auto" });
    await w.svc.extract(job.id);
    expect(w.page).toHaveBeenCalledWith("https://salon.example/menu", 200_000);
    expect((await w.svc.get(A, job.id)).status).toBe("review");

    const { CatalogImportFailure } = await import("./catalog-import-errors");
    const blocked = importWorld({ extractor, page: async () => Promise.reject(new CatalogImportFailure("catalog_import.url_blocked")) });
    const j2 = await blocked.svc.create(A, "uOwner", { source: "url", url: "https://internal.example/" });
    await blocked.svc.extract(j2.id);
    expect(await blocked.svc.get(A, j2.id)).toMatchObject({ status: "failed", errorKey: "catalog_import.url_blocked" });
  });

  it("synchronous refusals: url_invalid, text_too_long, ai_unavailable, a bad source or kind", async () => {
    const w = importWorld();
    expect((await failure(w.svc.create(A, "u", { source: "url", url: "http://salon.example/" }))).body.message).toBe("catalog_import.url_invalid");
    expect(await failure(w.svc.create(A, "u", { source: "paste", text: "x".repeat(200_001) }))).toEqual({
      status: 400,
      body: { statusCode: 400, message: "catalog_import.text_too_long", max: 200_000 },
    });
    expect((await failure(w.svc.create(A, "u", { source: "pdf" }))).body.message).toBe("catalog_import.source_invalid");
    expect((await failure(w.svc.create(A, "u", { source: "paste", text: "x", kind: "rooms" }))).body.message).toBe("catalog_import.source_invalid");
    const noAi = importWorld({ extractor: { available: () => false, extract: jest.fn() } });
    expect(await failure(noAi.svc.create(A, "u", { source: "paste", text: "Haircut" }))).toEqual({
      status: 503,
      body: { statusCode: 503, message: "catalog_import.ai_unavailable" },
    });
    // The template path still works without AI.
    expect((await noAi.svc.create(A, "u", { file: csv([SVC_HEADERS, ["Cut", "", "30", "", "", ""]]) })).status).toBe("review");
  });

  it("ai_failed and nothing_found end the job as failed", async () => {
    const { CatalogImportFailure } = await import("./catalog-import-errors");
    const bad = importWorld({ extractor: fakeExtractor(new CatalogImportFailure("catalog_import.ai_failed")) });
    const j = await bad.svc.create(A, "u", { source: "paste", text: "x" });
    await bad.svc.extract(j.id);
    expect(await bad.svc.get(A, j.id)).toMatchObject({ status: "failed", errorKey: "catalog_import.ai_failed" });
    expect(bad.prisma.db.catalogImport[0].inputText).toBeNull();
    const empty = importWorld({ extractor: fakeExtractor({ lang: "en", services: [], staff: [] }) });
    const j2 = await empty.svc.create(A, "u", { source: "paste", text: "nothing here" });
    await empty.svc.extract(j2.id);
    expect(await empty.svc.get(A, j2.id)).toMatchObject({ status: "failed", errorKey: "catalog_import.nothing_found" });
  });
});

describe("review edits are validated", () => {
  async function inReview() {
    const extractor = fakeExtractor({
      lang: "en",
      services: [{ title: "Haircut" }],
      staff: [{ title: "Sara", workingHours: [{ day: "mon", from: "09:00", to: "17:00" }] }],
    });
    const w = importWorld({ extractor });
    const job = await w.svc.create(A, "u", { source: "paste", text: "x" });
    await w.svc.extract(job.id);
    return { w, id: job.id };
  }

  it("duration out of bounds, negative price, bad schedule → 400 catalog_import.item_invalid {key, field}", async () => {
    const { w, id } = await inReview();
    const bad = async (items: unknown) => (await failure(w.svc.patchItems(A, id, items))).body;
    expect(await bad([{ key: "s1", data: { durationMin: 4 } }])).toEqual({ statusCode: 400, message: "catalog_import.item_invalid", key: "s1", field: "durationMin" });
    expect(await bad([{ key: "s1", data: { durationMin: 1441 } }])).toMatchObject({ field: "durationMin" });
    expect(await bad([{ key: "s1", data: { price: -5 } }])).toMatchObject({ key: "s1", field: "price" });
    expect(await bad([{ key: "s1", data: { price: "1.234" } }])).toMatchObject({ field: "price" });
    expect(await bad([{ key: "t1", data: { schedule: { mon: [{ from: "18:00", to: "09:00" }] } } }])).toMatchObject({ key: "t1", field: "schedule" });
    expect(await bad([{ key: "s1", data: { schedule: {} } }])).toMatchObject({ key: "s1", field: "schedule" }); // not a service field
    expect(await bad([{ key: "zz", selected: true }])).toMatchObject({ key: "zz", field: "key" });
    expect(await bad([{ key: "s1", selected: "yes" }])).toMatchObject({ field: "selected" });
    expect(await bad("nope")).toMatchObject({ field: "items" });
    // A refused patch changes nothing.
    expect((await w.svc.get(A, id)).items![0].data).toMatchObject({ durationMin: 60, durationDefaulted: true });
  });

  it("valid edits are saved (duration no longer defaulted, schedule normalized)", async () => {
    const { w, id } = await inReview();
    const dto = await w.svc.patchItems(A, id, [
      { key: "s1", data: { durationMin: 45, price: 80, nameAr: "قص" } },
      { key: "t1", selected: false, data: { schedule: { tue: [{ from: "13:00", to: "17:00" }, { from: "09:00", to: "12:00" }] } } },
    ]);
    expect(dto.items![0]).toMatchObject({ data: { durationMin: 45, durationDefaulted: false, price: "80.00", nameAr: "قص" }, selected: true });
    expect(dto.items![1]).toMatchObject({
      selected: false,
      data: { schedule: { tue: [{ from: "09:00", to: "12:00" }, { from: "13:00", to: "17:00" }] } },
    });
  });

  it("editing (or running) outside review → 409 catalog_import.not_in_review", async () => {
    const { w, id } = await inReview();
    await w.svc.run(A, id);
    expect(await failure(w.svc.patchItems(A, id, [{ key: "s1", selected: false }]))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "catalog_import.not_in_review", status: "running" },
    });
    expect((await failure(w.svc.run(A, id))).body.message).toBe("catalog_import.not_in_review");
  });

  it("run refuses a selected item with an error; cancel is idempotent and final jobs cannot be cancelled", async () => {
    const extractor = fakeExtractor({ lang: "en", services: [{ title: "X", durationMinutes: 2 }], staff: [] });
    const w = importWorld({ extractor });
    const job = await w.svc.create(A, "u", { source: "paste", text: "x" });
    await w.svc.extract(job.id);
    expect((await w.svc.get(A, job.id)).items![0]).toMatchObject({ selected: false, error: { field: "durationMin" } });
    await expect(w.svc.patchItems(A, job.id, [{ key: "s1", selected: true }])).resolves.toBeDefined();
    expect(await failure(w.svc.run(A, job.id))).toMatchObject({ body: { message: "catalog_import.item_invalid", key: "s1", field: "durationMin" } });
    expect((await w.svc.cancel(A, job.id)).status).toBe("cancelled");
    expect((await w.svc.cancel(A, job.id)).status).toBe("cancelled");
    w.prisma.db.catalogImport[0].status = "done";
    expect(await failure(w.svc.cancel(A, job.id))).toMatchObject({ status: 409, body: { message: "catalog_import.already_finished" } });
  });
});

describe("foreign ids return 404 on catalog import routes", () => {
  it("workspace B's job from A: get, patch, run, cancel → 404; list shows A's only (latest 10)", async () => {
    const extractor = fakeExtractor({ lang: "en", services: [{ title: "Cut" }], staff: [] });
    const w = importWorld({ extractor });
    const theirs = await w.svc.create(B, "uOther", { source: "paste", text: "x" });
    await w.svc.extract(theirs.id);
    for (const call of [
      () => w.svc.get(A, theirs.id),
      () => w.svc.patchItems(A, theirs.id, [{ key: "s1", selected: false }]),
      () => w.svc.run(A, theirs.id),
      () => w.svc.cancel(A, theirs.id),
    ]) {
      expect(await failure(call())).toEqual({ status: 404, body: { statusCode: 404, message: "catalog_import.not_found" } });
    }
    expect(w.prisma.db.catalogImport[0].status).toBe("review");
    for (let i = 0; i < 12; i++) await w.svc.create(A, "uOwner", { source: "paste", text: `t${i}` });
    const list = await w.svc.list(A);
    expect(list).toHaveLength(10);
    expect(list.every((j) => j.id !== theirs.id)).toBe(true);
  });
});

describe("logs never contain import content", () => {
  it("pasted text, page text, model output and the URL query never reach a Logger call", async () => {
    const secret = "SECRET-PASTE-حجز";
    const pageSecret = "SECRET-PAGE-TEXT";
    const modelSecret = "SECRET-MODEL-OUTPUT";
    const calls: string[] = [];
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        calls.push(args.map(String).join(" "));
      }),
    );
    try {
      const { CatalogImportFailure } = await import("./catalog-import-errors");
      const ok = importWorld({ extractor: fakeExtractor({ lang: "en", services: [{ title: modelSecret }], staff: [] }), page: async () => pageSecret });
      const p = await ok.svc.create(A, "u", { source: "paste", text: secret });
      await ok.svc.extract(p.id);
      const u = await ok.svc.create(A, "u", { source: "url", url: "https://salon.example/menu?token=QUERYSECRET" });
      await ok.svc.extract(u.id);
      await ok.svc.run(A, p.id);
      await ok.runner.run(p.id);
      const bad = importWorld({ extractor: fakeExtractor(new CatalogImportFailure("catalog_import.ai_failed")), page: async () => pageSecret });
      const b = await bad.svc.create(A, "u", { source: "url", url: "https://salon.example/x?token=QUERYSECRET" });
      await bad.svc.extract(b.id);
      expect(calls.length).toBeGreaterThan(0); // the failure was logged…
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = calls.join("\n");
    for (const s of [secret, pageSecret, modelSecret, "QUERYSECRET"]) expect({ s, logged: all.includes(s) }).toEqual({ s, logged: false });
  });
});
