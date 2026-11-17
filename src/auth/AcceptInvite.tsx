import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import { memberErrorKey, memberErrorText } from "@/screens/team/memberErrors";
import { isChallenge, useAuth, type LoginResponse } from "./context";
import { AuthBanner, AuthCard, AuthField, AuthTitle, authFieldStyle } from "./AuthCard";
import { TwoFactorStep } from "./TwoFactorStep";
import { leavePublicPage } from "./publicPageStore";
import { maskEmail } from "./maskEmail";

interface Preview {
  /** The invited address, masked (n***@example.com): the link alone never reveals it. */
  emailMasked: string;
  lang: "ar" | "en";
  workspace: { id: string; name: string };
  role: { id: string; name: string; nameAr: string } | null;
  invitedBy: { name: string } | null;
  expiresAt: string;
  accountExists: boolean;
}

const MIN = 8;

/**
 * SP-26 accept page (`/invite?token=…`). Every accept needs the emailed token
 * (C1): signed in, `POST /auth/invitations/accept {token}` (the email must
 * match); signed out with no account, `POST /invitations/accept` with a name
 * and password; signed out with an account, sign in here first.
 */
export function AcceptInvite({ token, tx, lang }: { token: string; tx: Tx; lang: "ar" | "en" }) {
  const { status, user, login, adoptSession, logout } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [signInEmail, setSignInEmail] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [rolePending, setRolePending] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoadError(tx("This invitation link is invalid or has expired. Ask for a new one.", "رابط الدعوة غير صالح أو منتهي الصلاحية. اطلب دعوة جديدة."));
      return;
    }
    let cancelled = false;
    api
      // POST: the token stays out of URLs and access logs (review M2).
      .post<Preview>("/invitations/preview", { token })
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setLoadError(memberErrorText(e, tx)));
    return () => {
      cancelled = true;
    };
    // tx changes with the language only; the preview does not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const signedIn = status === "authenticated" || status === "noWorkspace";
  const roleName = preview?.role ? tx(preview.role.name, preview.role.nameAr) : null;

  const enter = (res: LoginResponse & { rolePending?: boolean }) => {
    if (res.rolePending) {
      setRolePending(true);
      window.setTimeout(() => {
        adoptSession(res);
        leavePublicPage("dashboard");
      }, 2500);
      return;
    }
    adoptSession(res);
    leavePublicPage("dashboard");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(memberErrorText(e, tx));
      if (memberErrorKey(e) === "invitations.sign_in_required" && preview) setPreview({ ...preview, accountExists: true });
    } finally {
      setBusy(false);
    }
  };

  const join = () => run(async () => enter(await api.post<LoginResponse & { rolePending?: boolean }>("/auth/invitations/accept", { token })));

  const signUp = (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN) return setError(tx("Use at least 8 characters.", "استخدم 8 أحرف على الأقل."));
    void run(async () => enter(await api.post<LoginResponse & { rolePending?: boolean }>("/invitations/accept", { token, name: name.trim() || undefined, password })));
  };

  const signIn = (e: FormEvent) => {
    e.preventDefault();
    if (!preview) return;
    void run(async () => {
      // The preview only has the masked address: the invitee types their own.
      const res = await login(signInEmail.trim(), password);
      if (isChallenge(res)) setChallenge(res.challenge);
      setPassword("");
    });
  };

  const dir = lang === "ar" ? "rtl" : "ltr";

  if (loadError) {
    return (
      <AuthCard dir={dir}>
        <AuthTitle title={tx("Invitation", "الدعوة")} />
        <div style={{ display: "grid", gap: 12 }}>
          <AuthBanner message={loadError} />
          <button type="button" className="btn ghost" onClick={() => leavePublicPage()}>
            {tx("Continue", "متابعة")}
          </button>
        </div>
      </AuthCard>
    );
  }
  if (!preview) {
    return (
      <AuthCard dir={dir}>
        <div className="muted pulse" style={{ fontSize: 13 }}>{tx("Loading invitation…", "جارٍ تحميل الدعوة…")}</div>
      </AuthCard>
    );
  }

  const header = (
    <AuthTitle
      title={tx(`Join ${preview.workspace.name}`, `انضم إلى ${preview.workspace.name}`)}
      sub={[
        preview.invitedBy ? tx(`${preview.invitedBy.name} invited you`, `دعاك ${preview.invitedBy.name}`) : tx("You were invited", "تمت دعوتك"),
        roleName ? tx(`as ${roleName}.`, `بدور ${roleName}.`) : "",
      ].join(" ")}
    />
  );
  const emailRow = (
    <AuthField label={tx("Invited email", "البريد المدعو")}>
      <input value={preview.emailMasked} disabled dir="ltr" style={{ ...authFieldStyle, opacity: 0.7, fontFamily: "var(--font-mono)" }} />
    </AuthField>
  );

  if (rolePending) {
    return (
      <AuthCard dir={dir}>
        {header}
        <AuthBanner kind="info" message={tx("The invited role was removed, so you joined as a viewer. An owner can change your role.", "أُزيل الدور المدعو إليه، لذا انضممت كمشاهد. يمكن للمالك تغيير دورك.")} />
      </AuthCard>
    );
  }

  if (challenge) {
    return (
      <AuthCard dir={dir}>
        <TwoFactorStep challenge={challenge} tx={tx} onRestart={() => setChallenge(null)} />
      </AuthCard>
    );
  }

  if (signedIn && user) {
    // Only the masked address is known here; the server still checks the full one (403 invitations.email_mismatch).
    const mismatch = maskEmail(user.email.toLowerCase()) !== preview.emailMasked.toLowerCase();
    return (
      <AuthCard dir={dir}>
        {header}
        <div style={{ display: "grid", gap: 12 }}>
          {mismatch ? (
            <>
              <AuthBanner
                message={tx(
                  `This invitation is for ${preview.emailMasked}, but you're signed in as ${user.email}. Sign out and sign in with the invited email.`,
                  `هذه الدعوة موجهة إلى ${preview.emailMasked}، لكنك مسجّل الدخول باسم ${user.email}. سجّل الخروج ثم ادخل بالبريد المدعو.`,
                )}
              />
              <button type="button" className="btn" onClick={logout}>
                {tx("Sign out", "تسجيل الخروج")}
              </button>
            </>
          ) : (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void join()} style={{ height: 40 }}>
              {busy ? tx("Joining…", "جارٍ الانضمام…") : tx(`Join ${preview.workspace.name}`, `انضم إلى ${preview.workspace.name}`)}
            </button>
          )}
          {error && <AuthBanner message={error} />}
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard dir={dir}>
      {header}
      {preview.accountExists ? (
        <form onSubmit={signIn} style={{ display: "grid", gap: 12 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {tx("You already have an account. Sign in to join.", "لديك حساب بالفعل. سجّل الدخول للانضمام.")}
          </p>
          {emailRow}
          <AuthField label={tx("Your email", "بريدك الإلكتروني")}>
            <input
              type="email"
              required
              autoFocus
              dir="ltr"
              autoComplete="email"
              value={signInEmail}
              onChange={(e) => setSignInEmail(e.target.value)}
              style={authFieldStyle}
            />
          </AuthField>
          <AuthField label={tx("Password", "كلمة المرور")}>
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={authFieldStyle} />
          </AuthField>
          {error && <AuthBanner message={error} />}
          <button type="submit" className="btn primary" disabled={busy} style={{ height: 40 }}>
            {busy ? tx("Signing in…", "جارٍ الدخول…") : tx("Sign in to join", "سجّل الدخول للانضمام")}
          </button>
          <a href="#/forgot-password" style={{ fontSize: 13, textAlign: "center" }}>
            {tx("Forgot password?", "نسيت كلمة المرور؟")}
          </a>
        </form>
      ) : (
        <form onSubmit={signUp} style={{ display: "grid", gap: 12 }}>
          {emailRow}
          <AuthField label={tx("Your name", "الاسم")}>
            <input required autoFocus autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={authFieldStyle} />
          </AuthField>
          <AuthField label={tx("Choose a password (at least 8 characters)", "اختر كلمة مرور (8 أحرف على الأقل)")}>
            <input type="password" required minLength={MIN} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={authFieldStyle} />
          </AuthField>
          {error && <AuthBanner message={error} />}
          <button type="submit" className="btn primary" disabled={busy} style={{ height: 40 }}>
            {busy ? tx("Creating your account…", "جارٍ إنشاء حسابك…") : tx("Create account and join", "أنشئ الحساب وانضم")}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
