/**
 * SP-21 typed-document templates (D1: `exceljs`). One header row per kind;
 * required headers are filled green `C6EFCE` with bold dark-green `006100`
 * text (Tkana's styling), optional headers bold only.
 */
import * as ExcelJS from "exceljs";
import { TYPED_COLUMNS, type TypedKind } from "./typed-docs";

export const REQUIRED_FILL = "FFC6EFCE";
export const REQUIRED_FONT = "FF006100";

const SHEET_NAME: Record<TypedKind, string> = { offers: "Offers", inventory: "Inventory", packages: "Packages" };

export function templateFileName(kind: TypedKind): string {
  return `kewy-${kind}-template.xlsx`;
}

export async function buildTypedTemplate(kind: TypedKind): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME[kind]);
  const columns = TYPED_COLUMNS[kind];
  const header = ws.addRow(columns.map((c) => c.name));
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    if (c.required) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: REQUIRED_FILL } };
      cell.font = { bold: true, color: { argb: REQUIRED_FONT } };
    } else {
      cell.font = { bold: true };
    }
  });
  ws.columns.forEach((c) => (c.width = 20));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
