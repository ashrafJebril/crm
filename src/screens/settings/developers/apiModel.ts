import { instantOf, workspaceTz } from "@/screens/calendar/bookingTime";
import type { ApiKey, KeyAction, KeyScopes, WebhookDelivery, WebhookEndpoint } from "@/lib/types";
import type { Tx } from "@/lib/tx";

/** Mirrors backend/src/api-keys/api-key-scopes.ts (apiModel.test.ts pins it). */
export const KEY_ACTIONS: readonly KeyAction[] = ["read", "write", "delete", "admin"];
export const KEY_RESOURCES = [
  "contacts",
  "conversations",
  "tickets",
  "pipelines",
  "bookings",
  "campaigns",
  "templates",
  "audiences",
  "reports",
] as const;
export type KeyResource = (typeof KEY_RESOURCES)[number];

/** Mirrors backend/src/webhooks/webhook-events.ts (pinned by the test). */
export const WEBHOOK_EVENTS = [
  "contact.created",
  "conversation.assigned",
  "message.received",
  "ticket.created",
  "ticket.stage_changed",
  "booking.created",
  "booking.completed",
] as const;

export const ROTATION_OVERLAP_HOURS = 24;
export const SIGNATURE_TOLERANCE_S = 300;
export const DEVELOPERS_DOC_HREF = "/developers.html";

export function resourceLabel(r: string, tx: Tx): string {
  const m: Record<string, [string, string]> = {
    contacts: ["Contacts", "جهات الاتصال"],
    conversations: ["Conversations", "المحادثات"],
    tickets: ["Tickets", "التذاكر"],
    pipelines: ["Pipelines", "المسارات"],
    bookings: ["Bookings", "الحجوزات"],
    campaigns: ["Campaigns", "الحملات"],
    templates: ["Templates", "القوالب"],
    audiences: ["Audiences", "الجماهير"],
    reports: ["Reports", "التقارير"],
  };
  const v = m[r];
  return v ? tx(v[0], v[1]) : r;
}

export function actionLabel(a: KeyAction, tx: Tx): string {
  switch (a) {
    case "read":
      return tx("Read", "قراءة");
    case "write":
      return tx("Write", "كتابة");
    case "delete":
      return tx("Delete", "حذف");
    case "admin":
      return tx("Admin", "إدارة كاملة");
  }
}

export function eventLabel(e: string, tx: Tx): string {
  const m: Record<string, [string, string]> = {
    "contact.created": ["Contact created", "إنشاء جهة اتصال"],
    "conversation.assigned": ["Conversation assigned", "إسناد محادثة"],
    "message.received": ["Message received", "استلام رسالة"],
    "ticket.created": ["Ticket created", "إنشاء تذكرة"],
    "ticket.stage_changed": ["Ticket stage changed", "تغيير مرحلة تذكرة"],
    "booking.created": ["Booking created", "إنشاء حجز"],
    "booking.completed": ["Booking completed", "اكتمال حجز"],
    ping: ["Test ping", "اختبار"],
  };
  const v = m[e];
  return v ? tx(v[0], v[1]) : e;
}

/** One resource row of the scope matrix: which boxes are ticked. */
export type ScopeRow = Record<KeyAction, boolean>;
export type ScopeMatrix = Record<KeyResource, ScopeRow>;

export const emptyRow = (): ScopeRow => ({ read: false, write: false, delete: false, admin: false });
export function emptyMatrix(): ScopeMatrix {
  return Object.fromEntries(KEY_RESOURCES.map((r) => [r, emptyRow()])) as ScopeMatrix;
}

/**
 * The implication rules (as on the server, where write maps to
 * view+create+update and admin to everything):
 *  - ticking write ticks read; ticking admin ticks all four;
 *  - unticking read clears write and admin; unticking anything clears admin.
 */
export function toggleScope(row: ScopeRow, action: KeyAction, on: boolean): ScopeRow {
  const next = { ...row, [action]: on };
  if (on) {
    if (action === "write") next.read = true;
    if (action === "admin") Object.assign(next, { read: true, write: true, delete: true, admin: true });
  } else {
    next.admin = false;
    if (action === "read") next.write = false;
  }
  return next;
}

/** Row toggle: all four on, or all off. */
export function toggleRow(row: ScopeRow): ScopeRow {
  const all = KEY_ACTIONS.every((a) => row[a]);
  return all ? emptyRow() : { read: true, write: true, delete: true, admin: true };
}

/** The backend shape `{resource: [actions]}` (admin alone when ticked). */
export function matrixToScopes(m: ScopeMatrix): KeyScopes {
  const out: KeyScopes = {};
  for (const r of KEY_RESOURCES) {
    const row = m[r];
    if (row.admin) out[r] = ["admin"];
    else {
      const acts = KEY_ACTIONS.filter((a) => a !== "admin" && row[a]);
      if (acts.length) out[r] = acts;
    }
  }
  return out;
}

/** Scopes → readable chips ("Contacts: Read, Write"). */
export function scopeSummary(scopes: KeyScopes, tx: Tx): string[] {
  return KEY_RESOURCES.filter((r) => scopes[r]?.length).map(
    (r) => `${resourceLabel(r, tx)}: ${(scopes[r] ?? []).map((a) => actionLabel(a, tx)).join(tx(", ", "، "))}`,
  );
}

/** Revoked wins over expired (a revoked key stays revoked after its expiry). */
export function keyStatus(k: Pick<ApiKey, "revokedAt" | "expiresAt">, now: Date = new Date()): ApiKey["status"] {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now.getTime()) return "expired";
  return "active";
}

export function keyStatusLabel(s: ApiKey["status"], tx: Tx): string {
  return s === "active" ? tx("Active", "نشط") : s === "expired" ? tx("Expired", "منتهي") : tx("Revoked", "ملغى");
}

export type Tone = "ok" | "warn" | "bad" | "";

/** Delivered → ok; pending after a failed attempt → warn (retrying); waiting → neutral; failed → bad. */
export function deliveryTone(d: Pick<WebhookDelivery, "status" | "attempts">): Tone {
  if (d.status === "delivered") return "ok";
  if (d.status === "failed") return "bad";
  return d.attempts > 0 ? "warn" : "";
}

export function deliveryStatusLabel(d: Pick<WebhookDelivery, "status" | "attempts">, tx: Tx): string {
  if (d.status === "delivered") return tx("Delivered", "تم التسليم");
  if (d.status === "failed") return tx("Failed", "فشل");
  return d.attempts > 0 ? tx("Retrying", "إعادة المحاولة") : tx("Pending", "قيد الانتظار");
}

/** Plain words for WebhookDelivery.lastError (the dispatcher's reasons). */
export function lastErrorText(err: string | null, tx: Tx): string | null {
  if (!err) return null;
  const http = /^http_(\d{3})$/.exec(err);
  if (http) return tx(`The endpoint answered ${http[1]}.`, `ردّت نقطة الاستقبال بالرمز ${http[1]}.`);
  switch (err) {
    case "timeout":
      return tx("No answer within 10 seconds.", "لم يصل رد خلال 10 ثوانٍ.");
    case "network_error":
      return tx("Could not connect to the endpoint.", "تعذّر الاتصال بنقطة الاستقبال.");
    case "dns_error":
      return tx("The endpoint's address could not be resolved.", "تعذّر العثور على عنوان نقطة الاستقبال.");
    case "redirect":
      return tx("The endpoint answered with a redirect. Redirects are not followed.", "ردّت نقطة الاستقبال بإعادة توجيه، ولا تتم متابعة إعادة التوجيه.");
    case "unsafe_url":
      return tx("The URL now points to a private or blocked address.", "يشير الرابط الآن إلى عنوان خاص أو محظور.");
    case "endpoint_disabled":
      return tx("Not sent: the endpoint was turned off.", "لم يُرسل: نقطة الاستقبال متوقفة.");
    default:
      return tx("Delivery failed.", "فشل التسليم.");
  }
}

export function disabledReasonText(ep: Pick<WebhookEndpoint, "active" | "disabledReason">, tx: Tx): string | null {
  if (ep.active) return null;
  switch (ep.disabledReason) {
    case "failing":
      return tx("Turned off after 72 hours of failed deliveries.", "أُوقفت بعد 72 ساعة من فشل التسليم.");
    case "unsafe_url":
      return tx("Turned off: the URL points to a private or blocked address.", "أُوقفت: يشير الرابط إلى عنوان خاص أو محظور.");
    default:
      return tx("Turned off.", "متوقفة.");
  }
}

/** Latin digits in both languages. */
export function shortDate(iso: string | null, lang: "en" | "ar"): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

/** A client-side mirror of the URL rule (https, no localhost); the server decides. */
export function looksLikeHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && !!u.hostname && u.hostname !== "localhost" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * SP-27 review M3: a key expiry picked as a day ends at 23:59:59 in the
 * WORKSPACE timezone (not the browser's), as an ISO instant.
 */
export function expiryInstant(dateISO: string, tz: string | null | undefined): string {
  const lastMinute = instantOf(dateISO, 23 * 60 + 59, workspaceTz(tz));
  return new Date(lastMinute.getTime() + 59_000).toISOString();
}

