import * as ExcelJS from "exceljs";
import { buildTypedTemplate, REQUIRED_FILL, REQUIRED_FONT, templateFileName } from "./typed-templates";
import { TYPED_COLUMNS, validateTypedSheet } from "./typed-docs";
import { TYPED_KINDS } from "./knowledge-constants";

describe("typed templates", () => {
  it.each(TYPED_KINDS)("the %s template has one header row, required headers green", async (kind) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildTypedTemplate(kind)) as any);
    const ws = wb.worksheets[0];
    expect(ws.rowCount).toBe(1);
    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    expect(headers).toEqual(TYPED_COLUMNS[kind].map((c) => c.name));
    TYPED_COLUMNS[kind].forEach((c, i) => {
      const cell = ws.getRow(1).getCell(i + 1);
      expect(cell.font?.bold).toBe(true);
      if (c.required) {
        expect((cell.fill as ExcelJS.FillPattern).fgColor?.argb).toBe(REQUIRED_FILL);
        expect(cell.font?.color?.argb).toBe(REQUIRED_FONT);
      } else {
        expect((cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb).not.toBe(REQUIRED_FILL);
      }
    });
    // A template's own header row passes the column check.
    expect(validateTypedSheet(kind, headers, [], []).missing).toEqual([]);
    expect(templateFileName(kind)).toBe(`kewy-${kind}-template.xlsx`);
  });
});
