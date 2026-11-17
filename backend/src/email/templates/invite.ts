import { button, escapeHtml, layout, type EmailBrand, type EmailLang } from "./layout";
import type { EmailMessage } from "../email-sender";

export interface InviteEmailInput {
  to: string;
  lang: EmailLang;
  workspaceName: string;
  inviterName: string | null;
  roleName: string | null;
  /** The accept link (carries the single-use token). */
  link: string;
  expiresAt: Date;
  brand?: EmailBrand;
}

/** Latin digits in both languages, as the app shows times (SP-04). */
function day(d: Date, lang: EmailLang): string {
  return new Intl.DateTimeFormat(lang === "ar" ? "ar-SA-u-nu-latn-ca-gregory" : "en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** The invitation email: one language, by Invitation.lang. */
export function inviteEmail(i: InviteEmailInput): EmailMessage {
  const ws = i.workspaceName;
  const who = i.inviterName?.trim() || null;
  const until = day(i.expiresAt, i.lang);
  const ar = i.lang === "ar";
  const subject = ar ? `دعوة للانضمام إلى ${ws}` : `You're invited to join ${ws}`;
  const intro = ar
    ? `${who ? `دعاك ${who}` : "تمت دعوتك"} للانضمام إلى مساحة العمل «${ws}»${i.roleName ? ` بدور ${i.roleName}` : ""}.`
    : `${who ? `${who} invited you` : "You have been invited"} to join the workspace “${ws}”${i.roleName ? ` as ${i.roleName}` : ""}.`;
  const cta = ar ? "قبول الدعوة" : "Accept invitation";
  const expiry = ar ? `تنتهي صلاحية هذه الدعوة في ${until}.` : `This invitation expires on ${until}.`;
  const ignore = ar
    ? "إذا لم تكن تتوقع هذه الدعوة فتجاهل هذه الرسالة."
    : "If you were not expecting this invitation, you can ignore this email.";
  const bodyHtml = [
    `<p style="margin-block:0 12px">${escapeHtml(intro)}</p>`,
    button(i.link, cta, i.brand),
    `<p style="margin-block:0 8px;color:#52525b;font-size:13px">${escapeHtml(expiry)}</p>`,
    `<p style="margin-block:0;color:#52525b;font-size:13px">${escapeHtml(ignore)}</p>`,
  ].join("\n");
  const text = [intro, "", `${cta}: ${i.link}`, "", expiry, ignore].join("\n");
  return {
    to: i.to,
    subject,
    html: layout({ lang: i.lang, title: subject, bodyHtml, brand: i.brand }),
    text,
    kind: "invite",
  };
}
