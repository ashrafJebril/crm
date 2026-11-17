import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "@/api/client";
import { useAuth, type LoginResponse } from "@/auth/context";
import type { Tx } from "@/lib/tx";
import { memberErrorText } from "@/screens/team/memberErrors";
import { ErrorRow, Field, SettingsCard, inputStyle } from "./form";

type Step = "idle" | "setup" | "codes" | "disable" | "regenerate";

const codeInput = {
  ...inputStyle,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.2em",
} as const;

/**
 * SP-26 "Two-step verification" on the profile tab. Setup shows the QR code
 * (drawn in the browser by `qrcode`; the secret never goes to a third party)
 * and the secret as text, then confirms a code. Recovery codes are shown
 * once, with copy and download. Enable and disable return a fresh session
 * (the server ends every other one), which is adopted here.
 */
export function TwoFactorCard({ tx, onStatus }: { tx: Tx; onStatus: (m: string) => void }) {
  const { user, adoptSession } = useAuth();
  const [step, setStep] = useState<Step>("idle");
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = user?.twoFA === true;

  useEffect(() => {
    if (!setup) return setQr(null);
    let cancelled = false;
    QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 180 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [setup]);

  const reset = () => {
    setCode("");
    setPassword("");
    setUseRecovery(false);
    setError(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(memberErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const factor = () => (useRecovery ? { recoveryCode: code.trim() } : { code });

  const start = () =>
    run(async () => {
      reset();
      setSetup(await api.post<{ secret: string; otpauthUrl: string }>("/auth/2fa/setup"));
      setStep("setup");
    });

  const enable = () =>
    run(async () => {
      const res = await api.post<LoginResponse & { recoveryCodes: string[] }>("/auth/2fa/enable", { code });
      adoptSession(res);
      setSetup(null);
      setCodes(res.recoveryCodes);
      setStep("codes");
      reset();
      onStatus(tx("Two-step verification is on. You were signed out on other devices.", "تم تفعيل التحقق بخطوتين وتسجيل خروجك من الأجهزة الأخرى."));
    });

  const disable = () =>
    run(async () => {
      const res = await api.post<LoginResponse>("/auth/2fa/disable", { password, ...factor() });
      adoptSession(res);
      setStep("idle");
      reset();
      onStatus(tx("Two-step verification is off. You were signed out on other devices.", "تم إيقاف التحقق بخطوتين وتسجيل خروجك من الأجهزة الأخرى."));
    });

  const regenerate = () =>
    run(async () => {
      const res = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { password, ...factor() });
      setCodes(res.recoveryCodes);
      setStep("codes");
      reset();
    });

  const download = () => {
    if (!codes) return;
    const blob = new Blob([`${tx("Recovery codes", "رموز الاسترداد")}\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const factorFields = (
    <>
      <Field label={tx("Password", "كلمة المرور")}>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
      </Field>
      <Field label={useRecovery ? tx("Recovery code", "رمز الاسترداد") : tx("Code from your app", "الرمز من التطبيق")}>
        <input
          dir="ltr"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete={useRecovery ? "off" : "one-time-code"}
          value={code}
          onChange={(e) => setCode(useRecovery ? e.target.value.slice(0, 12) : e.target.value.replace(/\D/g, "").slice(0, 6))}
          style={codeInput}
        />
      </Field>
      <button type="button" className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => { setUseRecovery((v) => !v); setCode(""); }}>
        {useRecovery ? tx("Use an authenticator code", "استخدم رمز تطبيق المصادقة") : tx("Use a recovery code", "استخدم رمز استرداد")}
      </button>
    </>
  );
  const factorOk = password.length > 0 && (useRecovery ? code.replace(/[\s-]/g, "").length === 8 : /^\d{6}$/.test(code));

  return (
    <SettingsCard
      title={tx("Two-step verification", "التحقق بخطوتين")}
      description={tx(
        "Ask for a code from an authenticator app when you sign in with your password. Single sign-on is not affected.",
        "اطلب رمزًا من تطبيق مصادقة عند تسجيل الدخول بكلمة المرور. لا يتأثر الدخول الموحّد.",
      )}
    >
      {step === "codes" && codes ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            {tx(
              "Save these recovery codes somewhere safe. Each works once, and they are shown only now.",
              "احفظ رموز الاسترداد هذه في مكان آمن. كل رمز يعمل مرة واحدة، ولن تُعرض مرة أخرى.",
            )}
          </div>
          <div dir="ltr" className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 6, fontSize: 13, padding: 12, background: "var(--bg-2)", borderRadius: "var(--r)" }}>
            {codes.map((c) => (
              <bdi key={c}>{c}</bdi>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn sm" onClick={() => void navigator.clipboard?.writeText(codes.join("\n"))}>
              {tx("Copy", "نسخ")}
            </button>
            <button type="button" className="btn sm" onClick={download}>
              {tx("Download", "تنزيل")}
            </button>
            <button type="button" className="btn primary sm" onClick={() => { setCodes(null); setStep("idle"); }}>
              {tx("I saved them", "حفظتها")}
            </button>
          </div>
        </div>
      ) : step === "setup" && setup ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13 }}>
            {tx("Scan this code with your authenticator app, or enter the key by hand.", "امسح هذا الرمز بتطبيق المصادقة، أو أدخل المفتاح يدويًا.")}
          </div>
          {qr && <img src={qr} alt={tx("QR code for your authenticator app", "رمز QR لتطبيق المصادقة")} width={180} height={180} style={{ borderRadius: 8, background: "#fff" }} />}
          <div className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
            <bdi dir="ltr">{setup.secret}</bdi>
          </div>
          <Field label={tx("Enter the 6-digit code to confirm", "أدخل الرمز المكوّن من 6 أرقام للتأكيد")}>
            <input dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={codeInput} />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn primary sm" disabled={busy || !/^\d{6}$/.test(code)} onClick={() => void enable()}>
              {tx("Turn on", "تفعيل")}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setSetup(null); setStep("idle"); reset(); }}>
              {tx("Cancel", "إلغاء")}
            </button>
          </div>
        </div>
      ) : step === "disable" || step === "regenerate" ? (
        <div style={{ display: "grid", gap: 10 }}>
          {factorFields}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className={step === "disable" ? "btn danger sm" : "btn primary sm"}
              disabled={busy || !factorOk}
              onClick={() => void (step === "disable" ? disable() : regenerate())}
            >
              {step === "disable" ? tx("Turn off", "إيقاف") : tx("Generate new codes", "إنشاء رموز جديدة")}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setStep("idle"); reset(); }}>
              {tx("Cancel", "إلغاء")}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: on ? "var(--ok)" : "var(--ink-3)" }}>
            {on ? tx("On", "مفعّل") : tx("Off", "غير مفعّل")}
          </span>
          {on ? (
            <>
              <button type="button" className="btn sm" onClick={() => { reset(); setStep("regenerate"); }}>
                {tx("New recovery codes", "رموز استرداد جديدة")}
              </button>
              <button type="button" className="btn danger sm" onClick={() => { reset(); setStep("disable"); }}>
                {tx("Turn off", "إيقاف")}
              </button>
            </>
          ) : (
            <button type="button" className="btn primary sm" disabled={busy} onClick={() => void start()}>
              {tx("Set up", "إعداد")}
            </button>
          )}
        </div>
      )}
      <ErrorRow message={error} />
    </SettingsCard>
  );
}
