import type { Tx } from "@/lib/tx";
import type { AuditEntry } from "@/lib/types";

type Line = (target: string, e: AuditEntry) => [string, string];

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every SP-26 audit action → "who did what" text (actor name prepended). */
const LINES: Record<string, Line> = {
  "member.added": (t) => [`added ${t}`, `أضاف ${t}`],
  "member.role_changed": (t) => [`changed the role of ${t}`, `غيّر دور ${t}`],
  "member.removed": (t, e) =>
    e.meta && typeof e.meta === "object" && (e.meta as { handoverTo?: unknown }).handoverTo
      ? [`removed ${t} and handed over their work`, `أزال ${t} وسلّم عمله`]
      : [`removed ${t}`, `أزال ${t}`],
  "member.handover": (t) => [`handed over the work of ${t}`, `سلّم عمل ${t}`],
  "member.password_set_by_admin": (t) => [`set a new password for ${t}`, `عيّن كلمة مرور جديدة لـ ${t}`],
  "invitation.created": (t) => [`invited ${t}`, `دعا ${t}`],
  "invitation.resent": (t) => [`resent the invitation to ${t}`, `أعاد إرسال الدعوة إلى ${t}`],
  "invitation.revoked": (t) => [`revoked the invitation to ${t}`, `ألغى الدعوة الموجهة إلى ${t}`],
  "invitation.accepted": (t) => [`accepted the invitation (${t})`, `قبل الدعوة (${t})`],
  "role.created": (t) => [`created the role ${t}`, `أنشأ الدور ${t}`],
  "role.updated": (t) => [`updated the role ${t}`, `حدّث الدور ${t}`],
  "role.deleted": (t, e) => [`deleted the role ${t || str(e.meta?.name)}`, `حذف الدور ${t || str(e.meta?.name)}`],
  "workspace.settings_updated": () => ["updated the workspace settings", "حدّث إعدادات مساحة العمل"],
  "security.2fa_enabled": () => ["turned on two-step verification", "فعّل التحقق بخطوتين"],
  "security.2fa_disabled": () => ["turned off two-step verification", "أوقف التحقق بخطوتين"],
  "security.2fa_reset_by_owner": (t) => [`reset two-step verification for ${t}`, `أعاد تعيين التحقق بخطوتين لـ ${t}`],
  "security.2fa_recovery_code_used": () => ["signed in with a recovery code", "سجّل الدخول برمز استرداد"],
  "security.2fa_recovery_codes_regenerated": () => ["generated new recovery codes", "أنشأ رموز استرداد جديدة"],
  "security.password_reset": () => ["reset their password by email", "أعاد تعيين كلمة مروره عبر البريد"],
};

export const AUDIT_ACTIONS = Object.keys(LINES);

export function auditActionLabel(action: string, tx: Tx): string {
  const fn = LINES[action];
  if (!fn) return action;
  const [en, ar] = fn("…", { meta: null } as AuditEntry);
  return tx(en, ar);
}

/** "Olivia invited new@x.test" in the viewer's language. */
export function auditLine(e: AuditEntry, tx: Tx): string {
  const actor = e.actor?.name || (e.actorKind === "system" ? tx("System", "النظام") : tx("Someone", "أحد الأعضاء"));
  const target = e.targetLabel ?? tx("a removed record", "سجل محذوف");
  const fn = LINES[e.action];
  if (!fn) return `${actor} · ${e.action}`;
  const [en, ar] = fn(target, e);
  return `${actor} ${tx(en, ar)}`;
}

/** Times in the workspace timezone with Latin digits (SP-04). */
export function auditTime(iso: string, lang: "en" | "ar", timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
