import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import { memberErrorText } from "@/screens/team/memberErrors";
import { AuthBanner, AuthCard, AuthField, AuthTitle, authFieldStyle, goToSignIn } from "./AuthCard";

/**
 * SP-26: "Forgot password?". The server answers 202 for every email (no
 * account enumeration), so this page says the same thing whatever the email:
 * if an account with a password exists, a link is on its way. Only a 429
 * (rate limit) is shown as an error.
 */
export function ForgotPassword({ tx, lang }: { tx: Tx; lang: "ar" | "en" }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/password/forgot", { email: email.trim(), lang });
      setSent(true);
    } catch (err) {
      setError(memberErrorText(err, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard dir={lang === "ar" ? "rtl" : "ltr"}>
      <AuthTitle
        title={tx("Forgot password?", "نسيت كلمة المرور؟")}
        sub={tx("Enter your email and we'll send you a link to set a new password.", "أدخل بريدك وسنرسل لك رابطًا لتعيين كلمة مرور جديدة.")}
      />
      {sent ? (
        <div style={{ display: "grid", gap: 12 }}>
          <AuthBanner
            kind="ok"
            message={tx(
              "If an account with a password exists for this email, a reset link is on its way. It works once and expires in 30 minutes.",
              "إذا كان هناك حساب بكلمة مرور لهذا البريد، فرابط إعادة التعيين في الطريق. يعمل مرة واحدة وتنتهي صلاحيته خلال 30 دقيقة.",
            )}
          />
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {tx(
              "No email? If email is not set up for your workspace, ask your owner to reset your password.",
              "لم يصلك بريد؟ إذا لم يكن البريد مُعدًّا لمساحة عملك، فاطلب من المالك إعادة تعيين كلمة المرور.",
            )}
          </p>
          <button type="button" className="btn ghost" onClick={goToSignIn}>
            {tx("Back to sign in", "العودة لتسجيل الدخول")}
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <AuthField label={tx("Email", "البريد الإلكتروني")}>
            <input
              type="email"
              dir="ltr"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={authFieldStyle}
            />
          </AuthField>
          {error && <AuthBanner message={error} />}
          <button type="submit" className="btn primary" disabled={busy} style={{ height: 40, fontSize: 14 }}>
            {busy ? tx("Sending…", "جارٍ الإرسال…") : tx("Send reset link", "أرسل رابط إعادة التعيين")}
          </button>
          <button type="button" className="btn ghost" onClick={goToSignIn}>
            {tx("Back to sign in", "العودة لتسجيل الدخول")}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
