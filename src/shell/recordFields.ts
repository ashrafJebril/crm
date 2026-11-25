import type { Lang } from "@/lib/types";
import type { RecordKind } from "@/lib/recordParam";

export type FieldValue = string | number | boolean | null;

const pair = (en: string, ar: string) => ({ en, ar });

/** Stable i18n labels for the field keys the records API returns. */
const LABELS: Record<string, { en: string; ar: string }> = {
  lifecycle: pair("Lifecycle", "مرحلة العميل"),
  phone: pair("Phone", "الهاتف"),
  email: pair("Email", "البريد الإلكتروني"),
  owner: pair("Owner", "المسؤول"),
  tags: pair("Tags", "الوسوم"),
  createdAt: pair("Created", "تاريخ الإنشاء"),
  updatedAt: pair("Updated", "آخر تحديث"),
  channel: pair("Channel", "القناة"),
  status: pair("Status", "الحالة"),
  assignee: pair("Assignee", "المكلّف"),
  escalated: pair("Escalated", "مُصعَّدة"),
  lastAt: pair("Last activity", "آخر نشاط"),
  number: pair("Number", "الرقم"),
  pipeline: pair("Pipeline", "المسار"),
  stage: pair("Stage", "المرحلة"),
  value: pair("Value", "القيمة"),
  service: pair("Service", "الخدمة"),
  start: pair("Starts", "الموعد"),
  staff: pair("Staff", "الموظف"),
  sent: pair("Sent", "أُرسلت"),
  delivered: pair("Delivered", "سُلّمت"),
  read: pair("Read", "قُرئت"),
  failed: pair("Failed", "فشلت"),
};

/** Fields that are folded into another row (their Arabic twin). */
const HIDDEN = new Set(["stageAr", "serviceAr"]);

const CHANNELS: Record<string, { en: string; ar: string }> = {
  whatsapp: pair("WhatsApp", "واتساب"),
  facebook: pair("Facebook", "فيسبوك"),
  instagram: pair("Instagram", "إنستغرام"),
  webchat: pair("Web chat", "محادثة الويب"),
  tiktok: pair("TikTok", "تيك توك"),
  l: pair("AI Agent", "وكيل الذكاء الاصطناعي"),
  Broadcast: pair("Broadcast", "بث"),
  Drip: pair("Drip", "تدريجية"),
  Trigger: pair("Trigger", "مُحفَّزة"),
};

const STATUSES: Record<RecordKind, Record<string, { en: string; ar: string }>> = {
  contact: {},
  ticket: {},
  conversation: {
    human: pair("With the team", "مع الفريق"),
    pending_customer: pair("Waiting for customer", "بانتظار العميل"),
    resolved: pair("Resolved", "تم الحل"),
    closed: pair("Closed", "مغلقة"),
    spam: pair("Spam", "رسائل مزعجة"),
  },
  booking: {
    confirmed: pair("Confirmed", "مؤكد"),
    pending: pair("Pending", "قيد الانتظار"),
    completed: pair("Completed", "مكتمل"),
    cancelled: pair("Cancelled", "ملغى"),
    "no-show": pair("No-show", "لم يحضر"),
  },
  campaign: {
    running: pair("Running", "قيد التشغيل"),
    scheduled: pair("Scheduled", "مجدولة"),
    draft: pair("Draft", "مسودة"),
    completed: pair("Completed", "مكتملة"),
    failed: pair("Failed", "فشلت"),
    cancelled: pair("Cancelled", "ملغاة"),
    paused: pair("Paused", "متوقفة"),
  },
};

const DATE_KEYS = new Set(["createdAt", "updatedAt", "start"]);

export function channelLabel(value: string, lang: Lang): string {
  const c = CHANNELS[value];
  return c ? (lang === "ar" ? c.ar : c.en) : value;
}

/** Localized date and time; unparseable input is returned unchanged. */
export function formatDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(lang === "ar" ? "ar" : "en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Readable subtitle for a record or link: raw channel / ISO values are formatted
 *  by kind, anything else uses the server text (Arabic variant when available). */
export function displaySubtitle(
  kind: RecordKind,
  subtitle: string | undefined,
  subtitleAr: string | undefined,
  lang: Lang,
): string {
  if (!subtitle && !subtitleAr) return "";
  if (lang === "ar" && subtitleAr) return subtitleAr;
  const raw = subtitle ?? "";
  if (kind === "conversation" || kind === "campaign") return channelLabel(raw, lang);
  if (kind === "booking") return formatDate(raw, lang);
  return raw;
}

export function fieldLabel(key: string, lang: Lang): string {
  const l = LABELS[key];
  return l ? l[lang === "ar" ? "ar" : "en"] : key;
}

export interface FieldRow {
  key: string;
  label: string;
  value: string;
  /** Free text that should pick its own direction (names, tags). */
  auto: boolean;
}

/** Turn the API's raw fields into display rows: translated labels and values,
 *  localized dates, Arabic stage/service names when the UI is Arabic. */
export function displayFields(
  kind: RecordKind,
  fields: { key: string; value: FieldValue }[],
  lang: Lang,
): FieldRow[] {
  const ar = lang === "ar";
  const byKey = new Map(fields.map((f) => [f.key, f.value]));
  const rows: FieldRow[] = [];
  for (const f of fields) {
    if (HIDDEN.has(f.key)) continue;
    const value = f.value;
    let auto = false;
    let text: string;
    if (value === null || value === "") {
      text = "—";
    } else if (typeof value === "boolean") {
      text = value ? (ar ? "نعم" : "Yes") : ar ? "لا" : "No";
    } else if (f.key === "stage" && ar && byKey.get("stageAr")) {
      text = String(byKey.get("stageAr"));
      auto = true;
    } else if (f.key === "service" && ar && byKey.get("serviceAr")) {
      text = String(byKey.get("serviceAr"));
      auto = true;
    } else if (DATE_KEYS.has(f.key)) {
      text = formatDate(String(value), lang);
    } else if (f.key === "channel") {
      text = channelLabel(String(value), lang);
    } else if (f.key === "status") {
      const s = STATUSES[kind][String(value)];
      text = s ? (ar ? s.ar : s.en) : String(value);
    } else if (f.key === "number") {
      text = `#${value}`;
    } else if (typeof value === "number") {
      text = value.toLocaleString(ar ? "ar" : "en-US");
    } else {
      text = String(value);
      auto = true;
    }
    rows.push({ key: f.key, label: fieldLabel(f.key, lang), value: text, auto });
  }
  return rows;
}

export function kindLabel(kind: RecordKind, lang: Lang): string {
  const ar = lang === "ar";
  switch (kind) {
    case "contact":
      return ar ? "جهة اتصال" : "Contact";
    case "conversation":
      return ar ? "محادثة" : "Conversation";
    case "ticket":
      return ar ? "تذكرة" : "Ticket";
    case "booking":
      return ar ? "حجز" : "Booking";
    case "campaign":
      return ar ? "حملة" : "Campaign";
  }
}
