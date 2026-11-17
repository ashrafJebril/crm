/**
 * SP-24 row model (pure): what one Automatic messages row shows and allows.
 * The server's `blockedReason` decides whether the switch can turn ON
 * (its enable gate); turning OFF is always allowed.
 */
import type { Permission } from "@/lib/permissions";
import type { LifecycleRow, TemplateVariant } from "@/lib/types";
import { LIFECYCLE_CATALOG, REMINDER_OFFSET_MAX, REMINDER_OFFSET_MIN, REMINDER_OFFSETS } from "./lifecycleCatalog";

type Copy = [en: string, ar: string];

export type Pill = "not_set_up" | "paused" | "in_review" | "rejected" | "approved";
export type RowAction = "setup" | "edit" | "resubmit" | "sync" | "recipient" | "offset";

export const PILL_COPY: Record<Pill, Copy> = {
  not_set_up: ["Not set up", "غير مُعدّ"],
  paused: ["Paused by WhatsApp", "أوقفه واتساب"],
  in_review: ["In review", "قيد المراجعة"],
  rejected: ["Rejected", "مرفوض"],
  approved: ["Approved", "معتمد"],
};

/** Row pill priority (as Tkana): not set up, paused, in review, rejected, approved. */
const PRIORITY: Pill[] = ["not_set_up", "paused", "in_review", "rejected", "approved"];

/** One template status → its pill. `disabled` blocks like a rejection; `failed` never reached review. */
export function variantPill(v: TemplateVariant | null): Pill {
  if (!v) return "not_set_up";
  switch (v.status) {
    case "approved":
      return "approved";
    case "paused":
      return "paused";
    case "rejected":
    case "disabled":
    case "failed":
      return "rejected";
    default:
      // pending | submitted | local
      return "in_review";
  }
}

/** The reason shown under a variant's pill (Meta's rejection reason, or ours). */
function variantReason(v: TemplateVariant | null): Copy | null {
  if (!v) return null;
  if (v.status === "rejected") {
    return v.rejectionReason
      ? [`Rejected by WhatsApp: ${v.rejectionReason}`, `رفضه واتساب: ${v.rejectionReason}`]
      : ["Rejected by WhatsApp.", "رفضه واتساب."];
  }
  if (v.status === "disabled") return ["Disabled by WhatsApp. Edit and resubmit it.", "عطّله واتساب. عدّله وأعد إرساله."];
  if (v.status === "failed") return ["Couldn't be sent to WhatsApp for review.", "تعذّر إرساله إلى واتساب للمراجعة."];
  if (v.status === "paused") return ["WhatsApp paused it after low-quality feedback.", "أوقفه واتساب بعد تقييمات منخفضة الجودة."];
  return null;
}

export const BLOCKED_COPY: Record<NonNullable<LifecycleRow["blockedReason"]>, Copy> = {
  template_rejected: [
    "Can't turn on: a message was rejected by WhatsApp. Fix and resubmit it first.",
    "لا يمكن التفعيل: رفض واتساب إحدى الرسائل. صحّحها وأعد إرسالها أولًا.",
  ],
  template_missing: [
    "Can't turn on: both the Arabic and English messages must exist. Set it up again.",
    "لا يمكن التفعيل: يجب وجود الرسالتين العربية والإنجليزية. أعد الإعداد.",
  ],
  whatsapp_not_connected: ["Can't turn on: WhatsApp isn't connected.", "لا يمكن التفعيل: واتساب غير متصل."],
};

export interface VariantView {
  lang: "ar" | "en";
  pill: Pill;
  reason: Copy | null;
  templateId: string | null;
  name: string | null;
}

export interface RowView {
  title: Copy;
  description: Copy;
  statusPill: Pill | null;
  switch: { shown: boolean; on: boolean; disabled: boolean; reason: Copy | null };
  actions: RowAction[];
  /** AR first: the main variant. */
  variants: VariantView[];
}

export function rowView(row: LifecycleRow, can: (permission: Permission) => boolean): RowView {
  const def = LIFECYCLE_CATALOG[row.key];
  const customer = row.audience === "customer";
  const variants: VariantView[] =
    customer && row.setUp
      ? (["ar", "en"] as const).map((lang) => {
          const v = row.variants?.[lang] ?? null;
          return { lang, pill: variantPill(v), reason: variantReason(v), templateId: v?.templateId ?? null, name: v?.name ?? null };
        })
      : [];

  let statusPill: Pill | null = null;
  if (!row.setUp) statusPill = "not_set_up";
  else if (customer) statusPill = PRIORITY.find((p) => variants.some((v) => v.pill === p)) ?? "approved";

  const needsFix = variants.some((v) => v.pill === "rejected");
  const actions: RowAction[] = [];
  if (!row.setUp && can("workflows.create")) actions.push("setup");
  if (row.setUp && customer && can("templates.update")) {
    if (variants.some((v) => v.templateId)) actions.push("edit");
    if (needsFix) actions.push("resubmit");
  }
  if (customer && can("templates.view")) actions.push("sync");
  if (row.setUp && can("workflows.update")) {
    if (!customer) actions.push("recipient");
    if (row.key === "booking_reminder") actions.push("offset");
  }

  // Turning on is the server's enable gate; turning off is always allowed.
  const blocked = !row.enabled && row.blockedReason !== null;
  return {
    title: def.title,
    description: def.description,
    statusPill,
    switch: {
      shown: row.setUp && can("workflows.update"),
      on: row.enabled,
      disabled: blocked,
      reason: blocked && row.blockedReason ? BLOCKED_COPY[row.blockedReason] : null,
    },
    actions,
    variants,
  };
}

/** Staff rows choose recipients; customer rows always send to the customer. */
export const offersRecipients = (row: Pick<LifecycleRow, "audience">) => row.audience === "staff";

/** The offset choices, plus the row's current value when it is not one of them (kept, never silently changed). */
export function offsetChoices(current: number | null): number[] {
  const base = REMINDER_OFFSETS.map((o) => o.minutes);
  return current !== null && !base.includes(current) && current >= REMINDER_OFFSET_MIN && current <= REMINDER_OFFSET_MAX
    ? [...base, current].sort((a, b) => a - b)
    : base;
}

/** "N h" / "N d" for an offset outside the presets. */
export function offsetLabel(minutes: number): Copy {
  const preset = REMINDER_OFFSETS.find((o) => o.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return [`${minutes / 1440} days before`, `قبل ${minutes / 1440} أيام`];
  const h = Math.round(minutes / 6) / 10;
  return [`${h} hours before`, `قبل ${h} ساعة`];
}

/** "Sent in the last 30 days: N · Skipped: M (reasons)" parts. */
export function skippedTotal(row: Pick<LifecycleRow, "skipped30d">): number {
  return Object.values(row.skipped30d ?? {}).reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
}

// ── the edit drawer's checks (mirror the server: template-gallery.edit.ts) ──

export const BODY_MAX = 1024;
const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

export const placeholdersOf = (body: string) => [...body.matchAll(PLACEHOLDER)].map((m) => Number(m[1]));

export type EditIssue = "empty" | "too_long" | "placeholders_changed" | "edge_placeholder";

export const EDIT_ISSUE_COPY: Record<EditIssue, Copy> = {
  empty: ["Write the message.", "اكتب الرسالة."],
  too_long: [`Keep the message under ${BODY_MAX} characters.`, `اجعل الرسالة أقل من ${BODY_MAX} حرفًا.`],
  placeholders_changed: [
    "Keep every placeholder ({{1}}, {{2}}…) exactly once, as in the original.",
    "أبقِ كل متغير ({{1}}، {{2}}…) مرة واحدة كما في الأصل.",
  ],
  edge_placeholder: [
    "The message can't start or end with a placeholder. Add a word before or after it.",
    "لا يمكن أن تبدأ الرسالة أو تنتهي بمتغير. أضف كلمة قبله أو بعده.",
  ],
};

/** The first problem with an edited body, or null. Placeholders must stay the same set, each once. */
export function validateEdit(original: string, next: string): EditIssue | null {
  const body = next.trim();
  if (!body) return "empty";
  if (body.length > BODY_MAX) return "too_long";
  const a = placeholdersOf(original).sort((x, y) => x - y);
  const b = placeholdersOf(body).sort((x, y) => x - y);
  if (a.length !== b.length || a.some((n, i) => n !== b[i])) return "placeholders_changed";
  if (/^\{\{\s*\d+\s*\}\}/.test(body) || /\{\{\s*\d+\s*\}\}$/.test(body)) return "edge_placeholder";
  return null;
}

/** The body split into text and named placeholders, for highlighting. */
export function bodyParts(body: string): ({ text: string } | { placeholder: number })[] {
  const out: ({ text: string } | { placeholder: number })[] = [];
  let last = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m.index! > last) out.push({ text: body.slice(last, m.index) });
    out.push({ placeholder: Number(m[1]) });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}

/** "Last synced …" in the workspace timezone (Latin digits); the server keeps it in memory, so null after a restart. */
export function syncedText(lastSyncedAt: string | null, tz: string | null | undefined, lang: "en" | "ar"): Copy {
  if (!lastSyncedAt) return ["Not synced since restart", "لم تتم المزامنة منذ إعادة التشغيل"];
  const d = new Date(lastSyncedAt);
  if (Number.isNaN(d.getTime())) return ["Not synced since restart", "لم تتم المزامنة منذ إعادة التشغيل"];
  const fmt = (locale: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: tz || undefined }).format(d);
    } catch {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    }
  };
  void lang;
  return [`Last synced ${fmt("en-GB")}`, `آخر مزامنة ${fmt("ar-u-nu-latn")}`];
}
