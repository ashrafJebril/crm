/**
 * SP-20 "Try your agent" tool lines (pure): one line per tool call, with a
 * label per tool id in both languages, consecutive repeats of the same tool
 * (and the same outcome) collapsed to `×n`, and simulated writes marked
 * "Not saved". An unknown tool id is shown by its id.
 */
import type { SandboxToolCall } from "@/lib/types";
import type { Tx } from "@/lib/tx";

export const TOOL_LABELS: Record<string, [en: string, ar: string]> = {
  list_appointments: ["Checked appointments", "اطّلع على المواعيد"],
  get_appointment: ["Opened an appointment", "فتح موعدًا"],
  list_services: ["Checked services", "اطّلع على الخدمات"],
  find_slots: ["Looked for free times", "بحث عن أوقات متاحة"],
  search_contacts: ["Searched customers", "بحث في العملاء"],
  get_contact: ["Opened a customer", "فتح بيانات عميل"],
  list_photos: ["Looked for photos", "بحث عن صور"],
  search_knowledge: ["Searched your knowledge", "بحث في المعرفة"],
  create_appointment: ["Would book an appointment", "سيحجز موعدًا"],
  update_appointment: ["Would change an appointment", "سيعدّل موعدًا"],
  cancel_appointment: ["Would cancel an appointment", "سيلغي موعدًا"],
  create_contact: ["Would add a customer", "سيضيف عميلًا"],
  update_contact: ["Would update a customer", "سيحدّث بيانات عميل"],
};

export const NOT_SAVED: [en: string, ar: string] = ["Not saved", "لم يُحفظ"];

export interface ToolLine {
  name: string;
  label: string;
  simulated: boolean;
  error: boolean;
  count: number;
  /** "×3" when the same call repeated, else "". */
  times: string;
  /** "Not saved" for a simulated write, else "". */
  badge: string;
}

export function toolLabel(name: string, tx: Tx): string {
  const l = TOOL_LABELS[name];
  return l ? tx(l[0], l[1]) : name;
}

export function toolLines(calls: SandboxToolCall[], tx: Tx): ToolLine[] {
  const out: ToolLine[] = [];
  for (const c of calls) {
    const error = c.error === true;
    const last = out[out.length - 1];
    if (last && last.name === c.name && last.simulated === c.simulated && last.error === error) {
      last.count += 1;
      last.times = `×${last.count}`;
      continue;
    }
    out.push({
      name: c.name,
      label: toolLabel(c.name, tx),
      simulated: c.simulated,
      error,
      count: 1,
      times: "",
      badge: c.simulated && !error ? tx(NOT_SAVED[0], NOT_SAVED[1]) : "",
    });
  }
  return out;
}
