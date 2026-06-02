import { useState, type FormEvent } from "react";
import { useAuth } from "./context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";

type Mode = "login" | "signup";

export function Login() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { login, register } = useAuth();

  const [mode, setMode] = useState<Mode>("login");

  // Login state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Signup state
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupWorkspace, setSignupWorkspace] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(loginEmail.trim(), loginPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  const onSignup = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register({
        name: signupName.trim(),
        email: signupEmail.trim(),
        password: signupPassword,
        workspaceName: signupWorkspace.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setSubmitting(false);
    }
  };

  const fieldStyle = {
    width: "100%",
    height: 38,
    padding: "0 12px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r)",
    color: "var(--ink)",
    fontSize: 14,
    outline: "none",
    fontFamily: "inherit",
  } as const;

  const labelTextStyle = {
    fontSize: 11,
    color: "var(--ink-3)",
    textTransform: "uppercase" as const,
    letterSpacing: 0.06,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        backgroundImage: `radial-gradient(circle at 20% 30%, var(--accent-soft), transparent 50%),
                          radial-gradient(circle at 80% 70%, oklch(0.72 0.18 268 / 0.12), transparent 60%)`,
        padding: 24,
      }}
    >
      <div
        className="card"
        style={{
          width: "100%",
          maxWidth: 440,
          padding: 32,
          background: "var(--bg-elev)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <span className="brand-mark" style={{ width: 36, height: 36, fontSize: 22 }}>
            A
          </span>
          <div>
            <div className="display" style={{ fontSize: 26, lineHeight: 1, color: "var(--ink)" }}>
              Aram<span style={{ color: "var(--accent)" }}>.</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {tx("AI WhatsApp agents", "وكلاء واتساب الذكية")}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 4,
            padding: 4,
            background: "var(--bg-2)",
            borderRadius: "var(--r)",
            marginBottom: 20,
          }}
        >
          {(["login", "signup"] as Mode[]).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                style={{
                  padding: "8px 12px",
                  borderRadius: "var(--r-sm, 6px)",
                  border: 0,
                  background: active ? "var(--bg-elev)" : "transparent",
                  color: active ? "var(--ink)" : "var(--ink-3)",
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  boxShadow: active ? "var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.2))" : "none",
                  transition: "background 120ms ease, color 120ms ease",
                }}
              >
                {m === "login"
                  ? tx("Sign in", "دخول")
                  : tx("Create account", "حساب جديد")}
              </button>
            );
          })}
        </div>

        {mode === "login" ? (
          <>
            <h1 style={{ margin: "0 0 4px", fontSize: 22, letterSpacing: "-0.02em" }}>
              {tx("Sign in to your workspace", "سجّل الدخول")}
            </h1>
            <p style={{ margin: "0 0 20px", color: "var(--ink-3)", fontSize: 13 }}>
              {tx("Welcome back. Use your team credentials.", "أهلاً بعودتك. استخدم بريد العمل.")}
            </p>

            <form onSubmit={onLogin} style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Email", "البريد الإلكتروني")}
                </span>
                <input
                  type="email"
                  required
                  autoFocus
                  autoComplete="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  style={fieldStyle}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Password", "كلمة المرور")}
                </span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  style={fieldStyle}
                />
              </label>

              {error && <ErrorBanner message={error} />}

              <button
                type="submit"
                className="btn primary"
                disabled={submitting}
                style={{ height: 40, marginTop: 4, fontSize: 14, opacity: submitting ? 0.6 : 1 }}
              >
                {submitting ? tx("Signing in…", "جارٍ الدخول…") : tx("Sign in", "دخول")}
              </button>
            </form>

          </>
        ) : (
          <>
            <h1 style={{ margin: "0 0 4px", fontSize: 22, letterSpacing: "-0.02em" }}>
              {tx("Create your workspace", "أنشئ مساحة عملك")}
            </h1>
            <p style={{ margin: "0 0 20px", color: "var(--ink-3)", fontSize: 13 }}>
              {tx(
                "Start free. You can invite teammates and connect WhatsApp later.",
                "ابدأ مجانًا. يمكنك دعوة الفريق وربط واتساب لاحقًا.",
              )}
            </p>

            <form onSubmit={onSignup} style={{ display: "grid", gap: 12 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Your name", "الاسم")}
                </span>
                <input
                  type="text"
                  required
                  autoFocus
                  autoComplete="name"
                  value={signupName}
                  onChange={(e) => setSignupName(e.target.value)}
                  placeholder={tx("Ashraf Jebril", "اشرف جبريل")}
                  style={fieldStyle}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Workspace name", "اسم مساحة العمل")}
                  <span style={{ color: "var(--ink-4)", marginInlineStart: 4 }}>
                    {tx("(optional)", "(اختياري)")}
                  </span>
                </span>
                <input
                  type="text"
                  autoComplete="organization"
                  value={signupWorkspace}
                  onChange={(e) => setSignupWorkspace(e.target.value)}
                  placeholder={tx("Acme Roses", "وردة عكا")}
                  style={fieldStyle}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Work email", "البريد الإلكتروني")}
                </span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={fieldStyle}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span className="mono" style={labelTextStyle}>
                  {tx("Password", "كلمة المرور")}
                  <span style={{ color: "var(--ink-4)", marginInlineStart: 4 }}>
                    {tx("(min 6 chars)", "(٦ خانات على الأقل)")}
                  </span>
                </span>
                <input
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  style={fieldStyle}
                />
              </label>

              {error && <ErrorBanner message={error} />}

              <button
                type="submit"
                className="btn primary"
                disabled={submitting}
                style={{ height: 40, marginTop: 4, fontSize: 14, opacity: submitting ? 0.6 : 1 }}
              >
                {submitting
                  ? tx("Creating workspace…", "جارٍ الإنشاء…")
                  : tx("Create workspace", "إنشاء")}
              </button>

              <div
                style={{
                  fontSize: 11,
                  color: "var(--ink-4)",
                  textAlign: "center",
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                {tx(
                  "By creating an account you agree to the terms and privacy policy.",
                  "بإنشاء حسابك أنت توافق على الشروط وسياسة الخصوصية.",
                )}
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: "var(--r)",
        background: "oklch(0.7 0.22 24 / 0.12)",
        color: "var(--bad)",
        fontSize: 13,
        border: "1px solid oklch(0.7 0.22 24 / 0.35)",
      }}
    >
      {message}
    </div>
  );
}
