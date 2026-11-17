/**
 * SP-18 starters (pure): suggested questions for the page the member is on,
 * in both languages, filtered by permission so a member never sees a starter
 * they cannot use (every listed permission is required).
 *
 * Ruling 13: the conversation page offers "Translate this conversation's
 * summary" here; SP-31's "Translate summary" button stays hidden.
 */
import type { Permission } from "@/lib/permissions";
import type { CopilotPageKey } from "@/lib/types";

export interface Starter {
  en: string;
  ar: string;
  needs: Permission[];
}

const S = (en: string, ar: string, ...needs: Permission[]): Starter => ({ en, ar, needs });

const CONVERSATION = [
  S("Summarise this conversation", "لخّص هذه المحادثة", "conversations.view"),
  S("Was the customer's issue resolved?", "هل حُلّت مشكلة العميل؟", "conversations.view"),
  S("Draft a reply", "اكتب مسودة رد", "conversations.view", "conversations.create"),
  S("Translate this conversation's summary", "ترجم ملخص هذه المحادثة", "conversations.view"),
];
const TICKETS = [
  S("Which tickets are about to breach their SLA?", "ما التذاكر التي توشك على تجاوز مهلة الخدمة؟", "tickets.view"),
  S("Which open tickets has nobody picked up?", "ما التذاكر المفتوحة التي لم يتولّها أحد؟", "tickets.view"),
];
const BOOKINGS = [
  S("What is booked for tomorrow?", "ما الحجوزات المسجّلة غدًا؟", "bookings.view"),
  S("Which bookings are still pending?", "ما الحجوزات التي ما زالت معلّقة؟", "bookings.view"),
];
const CAMPAIGNS = [S("How did my last campaign do?", "كيف كان أداء حملتي الأخيرة؟", "campaigns.view")];
const KNOWLEDGE = [S("What are customers asking that my knowledge doesn't answer?", "ما الذي يسأل عنه العملاء ولا تجيب عنه معرفتي؟", "knowledge.view", "conversations.view")];

export const STARTERS: Record<CopilotPageKey, Starter[]> = {
  dashboard: [
    S("What changed this week?", "ما الذي تغيّر هذا الأسبوع؟", "conversations.view"),
    S("Which conversations need a person now?", "ما المحادثات التي تحتاج إلى شخص الآن؟", "conversations.view"),
  ],
  inbox: [S("Which conversations need a person now?", "ما المحادثات التي تحتاج إلى شخص الآن؟", "conversations.view")],
  conversation: CONVERSATION,
  contacts: [S("Which customers haven't heard from us in a while?", "أي العملاء لم نتواصل معهم منذ فترة؟", "contacts.view", "conversations.view")],
  contact: [
    S("Give me a 30-second brief on this customer", "أعطني ملخصًا سريعًا عن هذا العميل", "contacts.view"),
    S("Any open tickets or upcoming bookings?", "هل هناك تذاكر مفتوحة أو حجوزات قادمة؟", "contacts.view"),
    S("Add a follow-up for tomorrow", "أضف متابعة ليوم غد", "contacts.view", "contacts.update"),
  ],
  pipeline: TICKETS,
  ticket: TICKETS,
  calendar: BOOKINGS,
  booking: BOOKINGS,
  followups: [S("What's overdue for me?", "ما المتأخر لديّ؟", "contacts.view")],
  campaigns: CAMPAIGNS,
  campaign: CAMPAIGNS,
  agent: KNOWLEDGE,
  knowledge: KNOWLEDGE,
  insights_support: [S("Why did the AI resolution rate change?", "لماذا تغيّر معدل الحل بالذكاء الاصطناعي؟", "reports.view")],
  insights_sales: [S("What changed in sales this period?", "ما الذي تغيّر في المبيعات خلال هذه الفترة؟", "reports.view")],
  other: [],
};

/** The starters this member can use on this page, in their language. */
export function startersFor(page: CopilotPageKey, can: (p: Permission) => boolean, lang: "en" | "ar"): string[] {
  return (STARTERS[page] ?? []).filter((s) => s.needs.every(can)).map((s) => (lang === "ar" ? s.ar : s.en));
}
