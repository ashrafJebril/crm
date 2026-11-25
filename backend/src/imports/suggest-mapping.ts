import type { FieldDef, ImportMapping } from "./import-rows";

const SYNONYMS: Record<string, string[]> = {
  phone: ["phone", "mobile", "cell", "tel", "telephone", "phone number", "mobile number", "whatsapp", "الجوال", "جوال", "الهاتف", "هاتف", "رقم الهاتف", "رقم الجوال", "الموبايل", "موبايل", "واتساب"],
  name: ["name", "full name", "fullname", "contact name", "customer name", "الاسم", "اسم", "الاسم الكامل", "اسم العميل"],
  firstName: ["first name", "firstname", "given name", "الاسم الأول", "الاسم الاول", "الأول"],
  lastName: ["last name", "lastname", "surname", "family name", "اسم العائلة", "العائلة", "الأخير", "الاسم الأخير", "الكنية"],
  email: ["email", "e-mail", "email address", "mail", "البريد", "البريد الإلكتروني", "البريد الالكتروني", "ايميل", "إيميل"],
  tags: ["tags", "tag", "labels", "الوسوم", "وسوم", "التصنيفات", "الوسم"],
  lifecycle: ["lifecycle", "stage", "status", "دورة الحياة", "المرحلة", "الحالة"],
  owner: ["owner", "assigned to", "assignee", "المسؤول", "المالك", "مسؤول"],
  source: ["source", "lead source", "المصدر", "مصدر"],
  industry: ["industry", "sector", "القطاع", "المجال", "الصناعة"],
  value: ["value", "deal value", "amount", "القيمة", "المبلغ"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ");

/** Header -> target guesses (EN + AR synonyms, custom field labels); each target used once. */
export function suggestMapping(headers: string[], defs: FieldDef[] = []): ImportMapping {
  const out: ImportMapping = {};
  const taken = new Set<string>();
  const lookup = new Map<string, string>();
  for (const [target, words] of Object.entries(SYNONYMS)) for (const w of words) lookup.set(norm(w), target);
  // Plain custom labels never override a built-in synonym ("Name" stays the name).
  for (const d of defs) {
    for (const w of [d.label, d.labelAr, d.key]) if (w && !lookup.has(norm(w))) lookup.set(norm(w), `custom:${d.id}`);
  }
  // The export's disambiguated form "Label (key)" always names the field.
  const byKey = new Map(defs.map((d) => [d.key.toLowerCase(), d.id]));
  for (const h of headers) {
    const m = /\(([^()]+)\)\s*(?:\d+)?\s*$/.exec(h.trim());
    const keyed = m ? byKey.get(m[1].trim().toLowerCase()) : undefined;
    const t = keyed ? `custom:${keyed}` : lookup.get(norm(h));
    if (t && (t === "tags" || !taken.has(t))) {
      out[h] = t;
      taken.add(t);
    } else out[h] = "ignore";
  }
  return out;
}
