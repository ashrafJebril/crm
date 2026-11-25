/**
 * SP-10 catalog import templates (approved D1: `exceljs`). One `.xlsx` per
 * kind with bilingual header notes and one example row. A file whose header
 * row equals a template's exactly is parsed deterministically (no AI).
 * Day cells read `09:00-13:00, 16:00-21:00`; empty or `off` / `عطلة` is a day off.
 */
import * as ExcelJS from "exceljs";
import { WEEKDAYS, type Weekday } from "../bookings/booking-time";

export type TemplateKind = "services" | "staff";

const DAY_HEADERS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export const TEMPLATE_HEADERS: Record<TemplateKind, string[]> = {
  services: ["Name", "Name (Arabic)", "Duration (minutes)", "Price", "Currency", "Description"],
  staff: ["Name", "Name (Arabic)", "Role", "Services", ...WEEKDAYS.map((d) => DAY_HEADERS[d])],
};

const NOTES: Record<TemplateKind, string[]> = {
  services: [
    "Service name (required) / اسم الخدمة (مطلوب)",
    "Arabic name / الاسم بالعربية",
    "Duration in minutes, 5-1440 / المدة بالدقائق",
    "Price, e.g. 120.50 / السعر",
    "ISO currency, e.g. SAR / العملة",
    "Optional description / وصف اختياري",
  ],
  staff: [
    "Name (required) / الاسم (مطلوب)",
    "Arabic name / الاسم بالعربية",
    "Role, e.g. Stylist / المسمى",
    "Service names, comma-separated / أسماء الخدمات مفصولة بفواصل",
    ...WEEKDAYS.map(() => "Hours, e.g. 09:00-13:00, 16:00-21:00; empty = off / الساعات؛ فارغ = عطلة"),
  ],
};

const EXAMPLE: Record<TemplateKind, (string | number)[]> = {
  services: ["Haircut", "قص الشعر", 45, "80.00", "SAR", "Wash and cut"],
  staff: ["Sara", "سارة", "Stylist", "Haircut, Beard trim", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "", "", "10:00-13:00, 16:00-21:00"],
};

export async function buildTemplate(kind: TemplateKind): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind === "services" ? "Services" : "Staff");
  const header = ws.addRow(TEMPLATE_HEADERS[kind]);
  header.font = { bold: true };
  TEMPLATE_HEADERS[kind].forEach((_, i) => {
    header.getCell(i + 1).note = NOTES[kind][i];
  });
  ws.addRow(EXAMPLE[kind]);
  ws.columns.forEach((c) => (c.width = 22));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const norm = (h: string) => h.replace(/\s+/g, " ").trim().toLowerCase();

/** The template kind whose header row equals `headers` exactly (case/space-insensitive), or null. */
export function matchTemplate(headers: string[]): TemplateKind | null {
  const got = headers.map(norm);
  while (got.length && !got[got.length - 1]) got.pop();
  for (const kind of ["services", "staff"] as const) {
    const want = TEMPLATE_HEADERS[kind].map(norm);
    if (got.length === want.length && got.every((h, i) => h === want[i])) return kind;
  }
  return null;
}

const DAY_OFF = new Set(["", "off", "closed", "-", "عطلة", "مغلق"]);

/**
 * A day cell → windows. `09:00-13:00, 16:00-21:00` (also `–`, `؛`, `;`).
 * Malformed → null (the row gets an item error; `validateSchedule` checks the rest).
 */
export function parseDayCell(cell: string): { from: string; to: string }[] | null {
  const v = cell.trim().toLowerCase();
  if (DAY_OFF.has(v)) return [];
  const out: { from: string; to: string }[] = [];
  for (const part of v.split(/[,;،؛]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/.exec(part);
    if (!m) return null;
    const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
    out.push({ from: pad(m[1]), to: pad(m[2]) });
  }
  return out;
}

export interface TemplateRows {
  services: { name: string; nameAr: string; durationMin: number | null; price: string; currency: string | null; description: string }[];
  staff: { name: string; nameAr: string; role: string; services: string[]; schedule: unknown }[];
}

/** True when `r` is exactly the example row `buildTemplate` writes (review M4). */
function isExampleRow(kind: TemplateKind, r: string[]): boolean {
  const want = EXAMPLE[kind].map((v) => String(v).trim());
  const got = r.map((c) => (c ?? "").toString().trim());
  while (got.length > want.length && !got[got.length - 1]) got.pop();
  return got.length <= want.length && want.every((v, i) => (got[i] ?? "") === v);
}

/** Deterministic parse of a template's data rows (blank rows and the template's own example row skipped). */
export function parseTemplateRows(kind: TemplateKind, rows: string[][]): TemplateRows {
  const out: TemplateRows = { services: [], staff: [] };
  for (const r of rows) {
    const cell = (i: number) => (r[i] ?? "").toString().trim();
    if (r.every((c) => !(c ?? "").toString().trim())) continue;
    if (isExampleRow(kind, r)) continue;
    if (kind === "services") {
      const d = cell(2);
      out.services.push({
        name: cell(0),
        nameAr: cell(1),
        // A non-number duration stays as NaN so the review flags it (not a silent default).
        durationMin: d === "" ? null : /^\d+$/.test(d) ? Number(d) : NaN,
        price: cell(3),
        currency: cell(4) || null,
        description: cell(5),
      });
    } else {
      const schedule: Record<string, unknown> = {};
      let bad = false;
      WEEKDAYS.forEach((day, i) => {
        const windows = parseDayCell(cell(4 + i));
        if (windows === null) bad = true;
        else if (windows.length) schedule[day] = windows;
      });
      out.staff.push({
        name: cell(0),
        nameAr: cell(1),
        role: cell(2),
        services: cell(3).split(/[,،]/).map((s) => s.trim()).filter(Boolean),
        // An unparsable day cell becomes an invalid schedule so the item shows the error.
        schedule: bad ? { invalid: true } : schedule,
      });
    }
  }
  return out;
}

/** Any other spreadsheet → text lines for extraction (`Header: value | …`). */
export function rowsToText(headers: string[], rows: string[][], maxChars: number): string {
  const lines: string[] = [];
  let size = 0;
  for (const r of rows) {
    const line = headers
      .map((h, i) => [h.trim(), (r[i] ?? "").toString().trim()] as const)
      .filter(([, v]) => v)
      .map(([h, v]) => (h ? `${h}: ${v}` : v))
      .join(" | ");
    if (!line) continue;
    size += line.length + 1;
    if (size > maxChars) break;
    lines.push(line);
  }
  return lines.join("\n");
}
