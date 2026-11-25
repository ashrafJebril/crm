import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { BrandLogo } from "@/components/BrandLogo";
import { ONBOARDING_PATH, patchOnboarding } from "@/screens/agent/agentApi";
import { BUSINESS_NAME_MAX } from "@/screens/agent/agentConstants";
import { agentErrorText } from "@/screens/agent/agentErrors";

/**
 * SP-20 standalone signup (`#/signup`, public, outside the app shell like
 * Login). Reuses `register` (the account and its workspace), then starts the
 * guided onboarding and opens `#/setup`. The signup limiter's 429
 * (`auth.register_rate`) has its own copy.
 */

export const isSignupHash = (hash: string) => /^#\/?signup(\?|$)/.test(hash);

/**
 * Review M5: while a signup is in flight the hash already reads #/setup (so
 * the app opens on the setup page the moment the account exists, with no
 * other route in between); the signup page stays on screen meanwhile.
 */
let signupInFlight = false;
export const signupPending = () => signupInFlight;

/** Re-renders when the hash switches between the sign-in and signup pages. */
export function useSignupHash(): boolean {
  const [on, setOn] = useState(() => isSignupHash(window.location.hash) || signupInFlight);
  useEffect(() => {
    const onHash = () => setOn(isSignupHash(window.location.hash) || signupInFlight);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return on;
}

export function Signup() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { register } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [business, setBusiness] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const businessLen = business.trim().length;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Point the app at #/setup before the auth state flips (the router reads
    // it now; this page stays up while the request runs).
    signupInFlight = true;
    window.location.hash = "#/setup";
    let registered = false;
    try {
      await register({ name: name.trim(), email: email.trim(), password, workspaceName: business.trim() });
      registered = true;
    } catch (err) {
      signupInFlight = false;
      window.location.hash = "#/signup";
      setError(agentErrorText(err, tx, err instanceof Error && err.message ? err.message : undefined));
      setBusy(false);
      return;
    } finally {
      if (registered) signupInFlight = false;
    }
    // The account exists now: start onboarding, then refresh the setup page's read
    // (a failure here only means the owner starts it from the agent page).
    try {
      await patchOnboarding({ action: "start", businessName: business.trim() });
    } catch {
      /* the agent page offers "Set up your agent" */
    }
    void queryClient.invalidateQueries({ queryKey: [ONBOARDING_PATH] });
  }

  const field = {
    width: "100%",
    height: 38,
    padding: "0 12px",
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: "var(--r)",
    color: "var(--ink)",
    fontSize: 14,
    fontFamily: "inherit",
  } as const;
  const label = { display: "grid", gap: 6, fontSize: 12 } as const;

  return (
    <div dir={t.lang === "ar" ? "rtl" : "ltr"} style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 24 }}>
      <form className="card" onSubmit={submit} style={{ width: "100%", maxWidth: 440, padding: 32, background: "var(--bg-elev)", display: "grid", gap: 14 }}>
        <BrandLogo />
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{tx("Create your account", "أنشئ حسابك")}</div>
          <div className="muted" style={{ fontSize: 13 }}>{tx("Then we'll set up your assistant together.", "ثم نُعدّ مساعدك معًا.")}</div>
        </div>
        <label style={label}>
          {tx("Your name", "اسمك")}
          <input dir="auto" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} style={field} />
        </label>
        <label style={label}>
          {tx("Email", "البريد الإلكتروني")}
          <input dir="ltr" required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={field} />
        </label>
        <label style={label}>
          {tx("Password", "كلمة المرور")}
          <input dir="ltr" required type="password" autoComplete="new-password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} style={field} />
        </label>
        <label style={label}>
          {tx("Business name", "اسم النشاط التجاري")}
          <input dir="auto" required maxLength={BUSINESS_NAME_MAX} value={business} onChange={(e) => setBusiness(e.target.value)} style={field} />
        </label>
        {error && (
          <div role="alert" style={{ color: "var(--bad)", fontSize: 13 }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || businessLen === 0 || businessLen > BUSINESS_NAME_MAX} style={{ height: 40, justifyContent: "center" }}>
          {busy ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create account", "إنشاء الحساب")}
        </button>
        <div className="muted" style={{ fontSize: 13, textAlign: "center" }}>
          {tx("Already have an account?", "لديك حساب بالفعل؟")} <a href="#/">{tx("Sign in", "تسجيل الدخول")}</a>
        </div>
      </form>
    </div>
  );
}
