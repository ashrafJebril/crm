import { button, escapeHtml, layout, type EmailBrand, type EmailLang } from "./layout";
import type { EmailMessage } from "../email-sender";

export interface ResetEmailInput {
  to: string;
  lang: EmailLang;
  name: string | null;
  /** The reset link (carries the single-use token). */
  link: string;
  /** Minutes until the link expires. */
  minutes: number;
  brand?: EmailBrand;
}

/** The password-reset email: one language, by ForgotPasswordDto.lang. */
export function resetEmail(i: ResetEmailInput): EmailMessage {
  const ar = i.lang === "ar";
  const subject = ar ? "إعادة تعيين كلمة المرور" : "Reset your password";
  const hello = i.name?.trim() ? (ar ? `مرحبًا ${i.name.trim()}،` : `Hi ${i.name.trim()},`) : ar ? "مرحبًا،" : "Hi,";
  const intro = ar
    ? "تلقّينا طلبًا لإعادة تعيين كلمة المرور لحسابك."
    : "We received a request to reset the password for your account.";
  const cta = ar ? "إعادة تعيين كلمة المرور" : "Reset password";
  const expiry = ar ? `ينتهي هذا الرابط خلال ${i.minutes} دقيقة ويعمل مرة واحدة.` : `This link expires in ${i.minutes} minutes and works once.`;
  const ignore = ar
    ? "إذا لم تطلب ذلك فتجاهل هذه الرسالة؛ لن تتغير كلمة المرور."
    : "If you did not ask for this, ignore this email; your password will not change.";
  const bodyHtml = [
    `<p style="margin-block:0 8px">${escapeHtml(hello)}</p>`,
    `<p style="margin-block:0 12px">${escapeHtml(intro)}</p>`,
    button(i.link, cta, i.brand),
    `<p style="margin-block:0 8px;color:#52525b;font-size:13px">${escapeHtml(expiry)}</p>`,
    `<p style="margin-block:0;color:#52525b;font-size:13px">${escapeHtml(ignore)}</p>`,
  ].join("\n");
  const text = [hello, "", intro, "", `${cta}: ${i.link}`, "", expiry, ignore].join("\n");
  return { to: i.to, subject, html: layout({ lang: i.lang, title: subject, bodyHtml, brand: i.brand }), text, kind: "password_reset" };
}
