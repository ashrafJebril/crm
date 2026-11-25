import { ApiError } from "@/api/client";
import { arabicServerMessage } from "@/lib/roleErrors";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

/**
 * Copy for every SP-26 error key (backend/src/members/member-errors.ts and
 * backend/src/auth/auth-errors.ts; memberErrors.test.ts pins the lists).
 */
export const MEMBER_ERROR_COPY: Record<string, [string, string]> = {
  // members/member-errors.ts
  "invitations.invalid_email": ["Enter a valid email address.", "أدخل بريدًا إلكترونيًا صحيحًا."],
  "invitations.email_mismatch": [
    "This invitation was sent to a different email. Sign in with that email to accept it.",
    "أُرسلت هذه الدعوة إلى بريد آخر. سجّل الدخول بذلك البريد لقبولها.",
  ],
  "invitations.role_above_actor": [
    "You can't invite someone into a role with more access than yours.",
    "لا يمكنك دعوة شخص إلى دور بصلاحيات أعلى من صلاحياتك.",
  ],
  "invitations.not_found": ["This invitation no longer exists.", "هذه الدعوة لم تعد موجودة."],
  "members.not_found": ["This member is no longer in the workspace.", "هذا العضو لم يعد في مساحة العمل."],
  "workspaces.slug_not_found": ["No workspace matches this link.", "لا توجد مساحة عمل تطابق هذا الرابط."],
  "invitations.already_member": ["This person is already a member.", "هذا الشخص عضو بالفعل."],
  "invitations.pending_exists": [
    "An invitation to this email is already pending. Resend it instead.",
    "توجد دعوة معلّقة لهذا البريد. أعد إرسالها بدلًا من ذلك.",
  ],
  "invitations.sign_in_required": [
    "An account with this email already exists. Sign in to join.",
    "يوجد حساب بهذا البريد بالفعل. سجّل الدخول للانضمام.",
  ],
  "members.handover_required": [
    "This member still has open work. Choose who receives it first.",
    "لا يزال لدى هذا العضو عمل مفتوح. اختر من يستلمه أولًا.",
  ],
  "members.handover_refused": [
    "The recipient can't take this work. Choose someone else.",
    "لا يمكن للمستلم استلام هذا العمل. اختر عضوًا آخر.",
  ],
  "invitations.invalid": [
    "This invitation link is invalid or has expired. Ask for a new one.",
    "رابط الدعوة غير صالح أو منتهي الصلاحية. اطلب دعوة جديدة.",
  ],
  "invitations.resend_limited": [
    "This invitation was sent recently or too many times. Try again later.",
    "أُرسلت هذه الدعوة مؤخرًا أو مرات كثيرة. حاول لاحقًا.",
  ],
  "email.not_configured": [
    "Email is not set up for this workspace; ask your owner to reset your password.",
    "البريد الإلكتروني غير مُعدّ لمساحة العمل هذه؛ اطلب من المالك إعادة تعيين كلمة المرور.",
  ],
  // auth/auth-errors.ts
  "auth.password_too_short": ["Use at least 8 characters.", "استخدم 8 أحرف على الأقل."],
  "auth.2fa_code_invalid": ["That code didn't work. Check it and try again.", "الرمز غير صحيح. تحقّق منه وحاول مرة أخرى."],
  "auth.session_expired": ["Your session ended. Sign in again.", "انتهت جلستك. سجّل الدخول مرة أخرى."],
  "auth.2fa_challenge_invalid": [
    "This sign-in step expired. Sign in again.",
    "انتهت صلاحية خطوة الدخول هذه. سجّل الدخول مرة أخرى.",
  ],
  "auth.2fa_already_enabled": ["Two-step verification is already on.", "التحقق بخطوتين مفعّل بالفعل."],
  "auth.2fa_not_enabled": ["Two-step verification is not on.", "التحقق بخطوتين غير مفعّل."],
  "auth.reset_invalid": [
    "This reset link is invalid, used or expired. Ask for a new one.",
    "رابط إعادة التعيين غير صالح أو مستخدم أو منتهي. اطلب رابطًا جديدًا.",
  ],
  "auth.rate_limited": ["Too many attempts. Try again later.", "محاولات كثيرة. حاول لاحقًا."],
  "auth.encryption_unavailable": [
    "Two-step verification isn't available on this server yet.",
    "التحقق بخطوتين غير متاح على هذا الخادم بعد.",
  ],
};

export const MEMBER_ERROR_KEYS = Object.keys(MEMBER_ERROR_COPY);

function bodyOf(e: unknown): Record<string, unknown> | null {
  if (e instanceof ApiError && e.body && typeof e.body === "object") return e.body as Record<string, unknown>;
  return null;
}

/** The error key an ApiError carries, if it is one of ours. */
export function memberErrorKey(e: unknown): string | null {
  const msg = bodyOf(e)?.message ?? (e instanceof Error ? e.message : null);
  return typeof msg === "string" && MEMBER_ERROR_COPY[msg] ? msg : null;
}

/** Seconds to wait from a 429 body (`retryAfterSec`), if any. */
export function retryAfter(e: unknown): number | null {
  const v = bodyOf(e)?.retryAfterSec;
  return typeof v === "number" && v > 0 ? Math.ceil(v) : null;
}

/** User-facing text for any members/auth error, in the viewer's language. */
export function memberErrorText(e: unknown, tx: Tx): string {
  const key = memberErrorKey(e);
  const wait = e instanceof ApiError && e.status === 429 ? retryAfter(e) : null;
  const waitText = wait ? tx(` Try again in ${wait} s.`, ` حاول بعد ${wait} ث.`) : "";
  if (key) {
    const [en, ar] = MEMBER_ERROR_COPY[key]!;
    return wait ? tx(en.replace(/ Try again later\.$/, ""), ar.replace(/ حاول لاحقًا\.$/, "")) + waitText : tx(en, ar);
  }
  if (e instanceof ApiError && e.status === 429) return tx("Too many attempts.", "محاولات كثيرة.") + (waitText || tx(" Try again later.", " حاول لاحقًا."));
  if (e instanceof ApiError && e.status === 403 && /permission/i.test(e.message)) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const ar = arabicServerMessage(msg);
  return ar ? tx(msg, ar) : msg || tx("Something went wrong.", "حدث خطأ ما.");
}
