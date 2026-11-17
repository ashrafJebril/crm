import { useState, type FormEvent } from "react";
import { useAuth } from "./context";
import type { Tx } from "@/lib/tx";
import { memberErrorKey, memberErrorText } from "@/screens/team/memberErrors";
import { AuthBanner, AuthField, AuthTitle, authFieldStyle } from "./AuthCard";

/**
 * SP-26: the second sign-in step after `{twoFactorRequired, challenge}`: a
 * 6-digit code from the authenticator app, or one recovery code. An expired
 * or used-up challenge sends the user back to the password step.
 */
export function TwoFactorStep({ challenge, tx, onRestart }: { challenge: string; tx: Tx; onRestart: () => void }) {
  const { completeTwoFactor } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = useRecovery ? code.replace(/[\s-]/g, "").length === 8 : /^\d{6}$/.test(code);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await completeTwoFactor(challenge, useRecovery ? { recoveryCode: code.trim() } : { code });
    } catch (err) {
      if (memberErrorKey(err) === "auth.2fa_challenge_invalid") {
        onRestart();
        return;
      }
      setError(memberErrorText(err, tx));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AuthTitle
        title={tx("Two-step verification", "التحقق بخطوتين")}
        sub={
          useRecovery
            ? tx("Enter one of your recovery codes. Each code works once.", "أدخل أحد رموز الاسترداد. كل رمز يعمل مرة واحدة.")
            : tx("Enter the 6-digit code from your authenticator app.", "أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.")
        }
      />
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <AuthField label={useRecovery ? tx("Recovery code", "رمز الاسترداد") : tx("Code", "الرمز")}>
          <input
            key={useRecovery ? "recovery" : "code"}
            dir="ltr"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value.slice(0, 12) : e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode={useRecovery ? "text" : "numeric"}
            autoComplete={useRecovery ? "off" : "one-time-code"}
            placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
            style={{ ...authFieldStyle, fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textAlign: "center" }}
          />
        </AuthField>
        {error && <AuthBanner message={error} />}
        <button type="submit" className="btn primary" disabled={busy || !valid} style={{ height: 40, fontSize: 14 }}>
          {busy ? tx("Checking…", "جارٍ التحقق…") : tx("Verify", "تحقّق")}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode("");
              setError(null);
            }}
          >
            {useRecovery ? tx("Use an authenticator code", "استخدم رمز تطبيق المصادقة") : tx("Use a recovery code", "استخدم رمز استرداد")}
          </button>
          <button type="button" className="btn ghost sm" onClick={onRestart}>
            {tx("Back", "رجوع")}
          </button>
        </div>
      </form>
    </>
  );
}
