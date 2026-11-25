import { useState, type FormEvent } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import { memberErrorText } from "@/screens/team/memberErrors";
import { AuthBanner, AuthCard, AuthField, AuthTitle, authFieldStyle, goToSignIn } from "./AuthCard";

const MIN = 8;

/**
 * SP-26: set a new password from the emailed link. The token was read from
 * the URL and scrubbed before this page rendered; it lives only in memory.
 * A reset signs you out everywhere and does not sign you in.
 */
export function ResetPassword({ token, tx, lang }: { token: string | null; tx: Tx; lang: "ar" | "en" }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN) return setError(tx("Use at least 8 characters.", "استخدم 8 أحرف على الأقل."));
    if (password !== confirm) return setError(tx("The passwords don't match.", "كلمتا المرور غير متطابقتين."));
    setBusy(true);
    try {
      await api.post("/auth/password/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(memberErrorText(err, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard dir={lang === "ar" ? "rtl" : "ltr"}>
      <AuthTitle title={tx("Set a new password", "تعيين كلمة مرور جديدة")} />
      {!token ? (
        <div style={{ display: "grid", gap: 12 }}>
          <AuthBanner message={tx("This reset link is invalid, used or expired. Ask for a new one.", "رابط إعادة التعيين غير صالح أو مستخدم أو منتهي. اطلب رابطًا جديدًا.")} />
          <a className="btn ghost" href="#/forgot-password">{tx("Ask for a new link", "اطلب رابطًا جديدًا")}</a>
        </div>
      ) : done ? (
        <div style={{ display: "grid", gap: 12 }}>
          <AuthBanner
            kind="ok"
            message={tx(
              "Your password was changed and you were signed out everywhere. Sign in with the new password.",
              "تم تغيير كلمة المرور وتسجيل خروجك من جميع الأجهزة. سجّل الدخول بكلمة المرور الجديدة.",
            )}
          />
          <button type="button" className="btn primary" onClick={goToSignIn}>
            {tx("Sign in", "تسجيل الدخول")}
          </button>
        </div>
      ) : (
        <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
          <AuthField label={tx("New password", "كلمة المرور الجديدة")}>
            <input type="password" required minLength={MIN} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={authFieldStyle} />
          </AuthField>
          <AuthField label={tx("Confirm new password", "تأكيد كلمة المرور الجديدة")}>
            <input type="password" required minLength={MIN} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={authFieldStyle} />
          </AuthField>
          {error && <AuthBanner message={error} />}
          <button type="submit" className="btn primary" disabled={busy} style={{ height: 40, fontSize: 14 }}>
            {busy ? tx("Saving…", "جارٍ الحفظ…") : tx("Set password", "تعيين كلمة المرور")}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
