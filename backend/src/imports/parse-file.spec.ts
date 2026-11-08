import * as ExcelJS from "exceljs";
import { ImportFileError, parseFile } from "./parse-file";

const buf = (s: string, bom = false) =>
  Buffer.from((bom ? "﻿" : "") + s, "utf8");

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  wb.addWorksheet("Second").addRow(["ignored"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function keyOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ImportFileError);
    return (e as ImportFileError).messageKey;
  }
  throw new Error("expected rejection");
}

describe("parseFile", () => {
  it("parses a CSV with a BOM and Arabic text", async () => {
    const r = await parseFile(buf("الاسم,الجوال\nأحمد,0501234567\nسارة,0509999999\n", true), "a.csv");
    expect(r.headers).toEqual(["الاسم", "الجوال"]);
    expect(r.rows).toEqual([
      ["أحمد", "0501234567"],
      ["سارة", "0509999999"],
    ]);
  });

  it("auto-detects semicolon CSV", async () => {
    const r = await parseFile(buf("name;phone\nAli;0501\nOmar;0502"), "a.csv");
    expect(r.headers).toEqual(["name", "phone"]);
    expect(r.rows).toEqual([["Ali", "0501"], ["Omar", "0502"]]);
  });

  it("handles quoted fields with commas, quotes and newlines", async () => {
    const r = await parseFile(buf('name,notes\n"Doe, John","said ""hi""\nthere"\n'), "a.csv");
    expect(r.rows).toEqual([["Doe, John", 'said "hi"\nthere']]);
  });

  it("handles CRLF line endings", async () => {
    const r = await parseFile(buf("a,b\r\n1,2\r\n3,4\r\n"), "a.csv");
    expect(r.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("uses the first non-empty row as headers and ignores empty columns", async () => {
    const r = await parseFile(buf(",,\nname,,phone\nAli,,0501\n"), "a.csv");
    expect(r.headers).toEqual(["name", "phone"]);
    expect(r.rows).toEqual([["Ali", "0501"]]);
  });

  it("suffixes duplicate headers with _2, _3", async () => {
    const r = await parseFile(buf("phone,phone,name,phone\n1,2,3,4"), "a.csv");
    expect(r.headers).toEqual(["phone", "phone_2", "name", "phone_3"]);
  });

  it("drops fully empty data rows", async () => {
    const r = await parseFile(buf("a,b\n1,2\n,\n\n3,4"), "a.csv");
    expect(r.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("parses the first XLSX sheet, coercing cells to strings and dates to ISO", async () => {
    const file = await xlsx([
      ["Name", "Phone", "Joined", "Value", "Link"],
      ["Ali", "0501234567", new Date(Date.UTC(2026, 0, 15)), 42, { text: "x", hyperlink: "http://x" }],
    ]);
    const r = await parseFile(file, "a.xlsx");
    expect(r.headers).toEqual(["Name", "Phone", "Joined", "Value", "Link"]);
    expect(r.rows).toEqual([["Ali", "0501234567", "2026-01-15", "42", "x"]]);
  });

  it("throws file_empty for empty CSV and header-only files", async () => {
    expect(await keyOf(parseFile(buf(""), "a.csv"))).toBe("imports.file_empty");
    expect(await keyOf(parseFile(buf("﻿  \n\n"), "a.csv"))).toBe("imports.file_empty");
    expect(await keyOf(parseFile(buf("name,phone\n"), "a.csv"))).toBe("imports.file_empty");
  });

  it("throws file_empty for an empty XLSX", async () => {
    expect(await keyOf(parseFile(await xlsx([]), "a.xlsx"))).toBe("imports.file_empty");
  });

  it("throws file_too_large above 50 000 data rows, accepts exactly 50 000", async () => {
    const lines = ["n,p"];
    for (let i = 0; i < 50_000; i++) lines.push(`n${i},${i}`);
    const ok = await parseFile(buf(lines.join("\n")), "a.csv");
    expect(ok.rows).toHaveLength(50_000);
    lines.push("x,1");
    expect(await keyOf(parseFile(buf(lines.join("\n")), "a.csv"))).toBe("imports.file_too_large");
  });

  it("throws file_too_large above 10 MB", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, "a");
    expect(await keyOf(parseFile(big, "a.csv"))).toBe("imports.file_too_large");
  });

  it("throws unsupported_type for other extensions", async () => {
    expect(await keyOf(parseFile(buf("x"), "a.txt"))).toBe("imports.unsupported_type");
    expect(await keyOf(parseFile(buf("x"), "a.xls"))).toBe("imports.unsupported_type");
  });

  it("throws file_invalid for a corrupt XLSX", async () => {
    expect(await keyOf(parseFile(buf("not a zip"), "a.xlsx"))).toBe("imports.file_invalid");
  });
});
