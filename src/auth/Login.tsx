import { useState, type FormEvent } from "react";
import { useAuth } from "./context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";

export function Login() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { login } = useAuth();

  const [email, setEmail] = useState("yara@samemha.com");
  const [password, setPassword] = useState("demo1234");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
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
          maxWidth: 420,
          padding: 32,
          background: "var(--bg-elev)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <span
            className="brand-mark"
            style={{ width: 36, height: 36, fontSize: 22 }}
          >
            t
          </span>
          <div>
            <div className="display" style={{ fontSize: 26, lineHeight: 1, color: "var(--ink)" }}>
              tkana<span style={{ color: "var(--accent)" }}>.</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {tx("AI WhatsApp agents", "وكلاء واتساب الذكية")}
            </div>
          </div>
        </div>

        <h1 style={{ margin: "0 0 4px", fontSize: 22, letterSpacing: "-0.02em" }}>
          {tx("Sign in to your workspace", "سجّل الدخول")}
        </h1>
        <p style={{ margin: "0 0 20px", color: "var(--ink-3)", fontSize: 13 }}>
          {tx("Welcome back. Use your team credentials.", "أهلاً بعودتك. استخدم بريد العمل.")}
        </p>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
              {tx("Email", "البريد الإلكتروني")}
            </span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={fieldStyle}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
              {tx("Password", "كلمة المرور")}
            </span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={fieldStyle}
            />
          </label>

          {error && (
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
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn primary"
            disabled={submitting}
            style={{ height: 40, marginTop: 4, fontSize: 14, opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? tx("Signing in…", "جارٍ الدخول…") : tx("Sign in", "دخول")}
          </button>
        </form>

        <div
          style={{
            marginTop: 24,
            padding: 12,
            borderRadius: "var(--r)",
            background: "var(--bg-2)",
            border: "1px dashed var(--line-soft)",
            fontSize: 12,
            color: "var(--ink-3)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <div style={{ marginBottom: 4, color: "var(--ink-2)" }}>
            {tx("Demo credentials (pre-filled):", "بيانات تجريبية:")}
          </div>
          yara@samemha.com / demo1234
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--ink-4)" }}>
            {tx(
              "Other seeded users: omar@samemha.com, lina@samemha.com, karim@samemha.com",
              "حسابات أخرى: omar@samemha.com, lina@samemha.com, karim@samemha.com",
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
