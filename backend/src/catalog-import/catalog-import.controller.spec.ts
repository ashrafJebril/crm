/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { CatalogImportController } from "./catalog-import.controller";
import { CATALOG_IMPORT_ERROR_KEYS, CATALOG_IMPORT_ERROR_STATUS, catalogImportError } from "./catalog-import-errors";
import { htmlToText, plainText } from "./html-to-text";
import { A } from "./catalog-import-test-world";

describe("catalog import controller", () => {
  const svc = { create: jest.fn(async () => ({ id: "j1" })) } as any;
  const ctrl = new CatalogImportController(svc);

  it("GET templates/:kind streams an .xlsx; an unknown kind is 400", async () => {
    const res = { setHeader: jest.fn(), send: jest.fn() } as any;
    await ctrl.template("staff", res);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="catalog-staff-template.xlsx"');
    const buf: Buffer = res.send.mock.calls[0][0];
    expect(buf.subarray(0, 2).toString()).toBe("PK"); // a zip (xlsx)
    await expect(ctrl.template("rooms", res)).rejects.toBeInstanceOf(HttpException);
  });

  it("POST passes JSON or multipart fields to the service; a file over 10 MB is refused", async () => {
    await ctrl.create(A, "u1", { source: "paste", text: "t", kind: "auto", extra: "ignored" }, undefined);
    expect(svc.create).toHaveBeenCalledWith(A, "u1", { source: "paste", kind: "auto", text: "t", url: undefined, file: undefined });
    const file = { buffer: Buffer.from("a"), originalname: "x.csv", size: 1 } as any;
    await ctrl.create(A, "u1", { kind: "services" }, file);
    expect(svc.create).toHaveBeenLastCalledWith(A, "u1", expect.objectContaining({ kind: "services", file: { buffer: file.buffer, originalname: "x.csv" } }));
    expect(() => ctrl.create(A, "u1", {}, { ...file, size: 11 * 1024 * 1024 })).toThrow(HttpException);
  });
});

describe("catalog import error keys and text helpers", () => {
  it.each(CATALOG_IMPORT_ERROR_KEYS)("%s builds an HttpException with the key as message", (key) => {
    const e = catalogImportError(key, { extra: 1 });
    expect(e.getStatus()).toBe(CATALOG_IMPORT_ERROR_STATUS[key]);
    expect(e.getResponse()).toEqual({ statusCode: CATALOG_IMPORT_ERROR_STATUS[key], message: key, extra: 1 });
  });

  it("the plan's keys are all present", () => {
    for (const k of [
      "text_too_long", "url_invalid", "url_blocked", "url_fetch_failed", "file_invalid", "too_many_rows",
      "ai_unavailable", "ai_failed", "nothing_found", "not_in_review", "item_invalid",
    ]) {
      expect(CATALOG_IMPORT_ERROR_KEYS).toContain(`catalog_import.${k}`);
    }
  });

  it("htmlToText drops scripts, styles and comments, keeps blocks as lines and decodes entities", () => {
    const html = `<html><head><title>Salon &amp; Spa</title><style>.x{}</style></head><body>
      <!-- hidden --><script>alert("x")</script><h1>Menu</h1><p>Haircut&nbsp;&mdash; 80&#160;SAR</p>
      <ul><li>Beard</li><li>قص &#x627;</li></ul><noscript>no</noscript></body></html>`;
    expect(htmlToText(html, 1000)).toBe("Salon & Spa\nMenu\nHaircut &mdash; 80 SAR\nBeard\nقص ا");
    expect(plainText("a\r\n\r\n  b  \t c", 100)).toBe("a\nb c");
  });
});
