import { escapeHtml, layout, type EmailBrand, type EmailLang } from "./layout";
import type { EmailMessage } from "../email-sender";

export interface TwoFactorResetEmailInput {
  to: string;
  lang: EmailLang;
  name: string | null;
  workspaceName: string;
  brand?: EmailBrand;
}

/** Tells a member an owner turned off their two-step verification. Carries
 *  no link or code. */
export function twoFactorResetEmail(i: TwoFactorResetEmailInput): EmailMessage {
  const ar = i.lang === "ar";
  const subject = ar ? "تم إيقاف التحقق بخطوتين لحسابك" : "Two-step verification was turned off";
  const hello = i.name?.trim() ? (ar ? `مرحبًا ${i.name.trim()}،` : `Hi ${i.name.trim()},`) : ar ? "مرحبًا،" : "Hi,";
  const body = ar
    ? `أوقف مالك مساحة العمل «${i.workspaceName}» التحقق بخطوتين لحسابك، وتم تسجيل خروجك من جميع الأجهزة. سجّل الدخول بكلمة المرور ثم فعّل التحقق بخطوتين من جديد من ملفك الشخصي.`
    : `An owner of the workspace “${i.workspaceName}” turned off two-step verification for your account, and you were signed out everywhere. Sign in with your password, then turn two-step verification on again from your profile.`;
  const warn = ar
    ? "إذا لم تتوقع ذلك فتواصل مع مالك مساحة العمل فورًا."
    : "If you did not expect this, contact the workspace owner right away.";
  const bodyHtml = [hello, body, warn].map((p) => `<p style="margin-block:0 12px">${escapeHtml(p)}</p>`).join("\n");
  return {
    to: i.to,
    subject,
    html: layout({ lang: i.lang, title: subject, bodyHtml, brand: i.brand }),
    text: [hello, "", body, "", warn].join("\n"),
    kind: "two_factor_reset",
  };
}
