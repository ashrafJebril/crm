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

/** The pre-fix regex implementation, kept here to pin identical output on well-formed pages. */
function legacyHtmlToText(html: string, maxChars: number): string {
  const DROP = /<(script|style|noscript|template|svg|iframe|object|embed|head)\b[\s\S]*?<\/\1\s*>/gi;
  const BLOCK = /<\/?(p|div|br|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|main|aside|dt|dd|dl|pre|blockquote|hr|figure|figcaption|address|option)\b[^>]*>/gi;
  const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
  const title = TITLE.exec(html)?.[1] ?? "";
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(new RegExp(TITLE.source, "gi"), " ")
    .replace(DROP, " ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]*>/g, " ");
  const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const decoded = `${title}\n${text}`.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
  return decoded
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars);
}

describe("htmlToText is linear (review I1)", () => {
  const WELL_FORMED = [
    `<html><head><title>Salon &amp; Spa</title><style>.x{}</style></head><body>
      <!-- hidden --><script>alert("x")</script><h1>Menu</h1><p>Haircut&nbsp;&mdash; 80&#160;SAR</p>
      <ul><li>Beard</li><li>قص &#x627;</li></ul><noscript>no</noscript></body></html>`,
    `<!DOCTYPE html><HTML><HEAD><TITLE lang="ar">صالون</TITLE><META charset="utf-8"></HEAD>
      <BODY><HEADER>Top</HEADER><Script type="x">var a = "<p>no</p>";</SCRIPT ><svg><text>icon</text></svg>
      <table><tr><td>Cut</td><td>50</td></tr><tr><th>Shave</th></tr></table><p-x>custom</p-x><pre>a  b</pre>
      <template><p>tpl</p></template><iframe src="x"></iframe ><br/><hr><option>Opt</option><headline>keep</headline></BODY></HTML>`,
    `<div>a<!-- one --> b <!-- two --><span>c</span></div><title>Late title</title><p>after</p><object>o</object><embed src="x.swf"><p>tail</p>`,
    `<p>a</p><svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>b</p><noscript>ns</noscript><object data="x"><param name="a"></object>`,
    `plain text, no tags at all & an ampersand`,
    `<p>x < y and y > z</p><a href="#">link</a><<p>>`,
  ];

  it("gives the same text as the regex version on well-formed pages", () => {
    for (const html of WELL_FORMED) expect({ html, out: htmlToText(html, 10_000) }).toEqual({ html, out: legacyHtmlToText(html, 10_000) });
  });

  it("an unclosed <script>, <style> or comment drops the rest of the page (raw text: nothing visible after it)", () => {
    expect(htmlToText(`<p>Menu</p><script>evil()<p>Cut</p>`, 1000)).toBe("Menu");
    expect(htmlToText(`<p>Menu</p><style>.a{}<p>Cut</p>`, 1000)).toBe("Menu");
    expect(htmlToText(`<p>Menu</p><!-- note <p>Cut</p>`, 1000)).toBe("Menu");
  });

  it("void, self-closing and unclosed optional elements keep the content after them (re-review I-A)", () => {
    expect(htmlToText(`<p>Before</p><embed src=x.swf><p>Haircut 100 SAR</p>`, 1000)).toBe("Before\nHaircut 100 SAR");
    expect(htmlToText(`<html><head><meta charset=utf-8><title>Salon</title><body><p>Haircut 100</p>`, 1000)).toBe("Salon\nHaircut 100");
    expect(htmlToText(`<p>A</p><svg viewBox='0 0 1 1'/><p>Haircut 100</p>`, 1000)).toBe("A\nHaircut 100");
    // No </head> and no <body>: only the opener goes.
    expect(htmlToText(`<head><meta charset=utf-8><p>Haircut 100</p>`, 1000)).toBe("Haircut 100");
    // An unclosed <head> ends at <body>; head content stays dropped.
    expect(htmlToText(`<head><style>.a{}</style>hidden<BODY class=x><p>Cut 50</p></body>`, 1000)).toBe("Cut 50");
    // An unclosed <title>, <noscript>, <iframe> or <object> loses only its opener.
    expect(htmlToText(`<p>Menu</p><title>Shop<p>Cut</p>`, 1000)).toBe("Menu\nShop\nCut");
    expect(htmlToText(`<p>Menu</p><noscript><p>Cut</p>`, 1000)).toBe("Menu\nCut");
    expect(htmlToText(`<p>Menu</p><object data=x><p>Cut</p><iframe src=y><p>Shave</p>`, 1000)).toBe("Menu\nCut\nShave");
    // A later closed element of the same name is still dropped whole.
    expect(htmlToText(`<svg/><p>A</p><svg><text>icon</text></svg><p>B</p>`, 1000)).toBe("A\nB");
  });

  it.each([
    ["<embed>"],
    ["<svg/>"],
    ["<head>"],
    ["<object>"],
    ["<noscript>x"],
    ["<head><p>"],
  ])("2 MB of %j (no closers) stays linear", (unit) => {
    expectLinear(unit);
  });

  it.each([
    ["<!--"],
    ["<script>"],
    ["<title>"],
    ["<style>"],
    ["<p"],
    ["<"],
    ["<head"],
  ])("2 MB of %j stays linear", (unit) => {
    expectLinear(unit);
  });
});

/**
 * Final review M1: a wall-clock limit flaked under parallel jest. Instead,
 * doubling the input must roughly double the time (well under 4x: a
 * quadratic path quadruples), plus a generous absolute cap (the old
 * quadratic stripping took minutes on 2 MB). A floor keeps millisecond
 * noise from failing the ratio.
 */
function timeStrip(unit: string, bytes: number): number {
  const html = unit.repeat(Math.ceil(bytes / unit.length));
  const t0 = process.hrtime.bigint();
  htmlToText(html, 200_000);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
function expectLinear(unit: string) {
  timeStrip(unit, 64 * 1024); // warm up
  const one = Math.min(timeStrip(unit, 1024 * 1024), timeStrip(unit, 1024 * 1024));
  const two = Math.min(timeStrip(unit, 2 * 1024 * 1024), timeStrip(unit, 2 * 1024 * 1024));
  expect(two).toBeLessThan(5000);
  expect({ unit, ratioOk: two <= Math.max(4 * one, 50) }).toEqual({ unit, ratioOk: true });
}
