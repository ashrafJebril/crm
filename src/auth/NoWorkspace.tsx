import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/api/client";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { memberErrorText } from "@/screens/team/memberErrors";
import { useAuth } from "./context";
import { AuthBanner, AuthCard, AuthField, AuthTitle, authFieldStyle } from "./AuthCard";

/**
 * SP-26 ruling 6: signed in, but in no workspace (removed, or invited and not
 * yet joined). Pending invitations are only counted (C1: only the emailed
 * link can accept), with "open the link in your email"; or create a
 * workspace.
 */
export function NoWorkspace() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { user, logout, createWorkspace, switchWorkspace } = useAuth();
  const [pending, setPending] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ pending: number }>("/auth/invitations")
      .then((r) => !cancelled && setPending(r.pending))
      .catch(() => !cancelled && setPending(0));
    return () => {
      cancelled = true;
    };
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkspace(name.trim());
      await switchWorkspace(ws.id);
    } catch (err) {
      setError(memberErrorText(err, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard dir={t.lang === "ar" ? "rtl" : "ltr"}>
      <AuthTitle
        title={tx("You're not in any workspace yet", "لست عضوًا في أي مساحة عمل بعد")}
        sub={user ? tx(`Signed in as ${user.email}`, `مسجّل الدخول باسم ${user.email}`) : undefined}
      />
      <div style={{ display: "grid", gap: 16 }}>
        {pending !== null && pending > 0 && (
          <AuthBanner
            kind="info"
            message={tx(
              "You have a pending invitation — open the link in your email.",
              "لديك دعوة معلّقة — افتح الرابط في بريدك الإلكتروني.",
            )}
          />
        )}
        <form onSubmit={create} style={{ display: "grid", gap: 12 }}>
          <AuthField label={tx("Create a workspace", "أنشئ مساحة عمل")}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("Workspace name", "اسم مساحة العمل")} style={authFieldStyle} />
          </AuthField>
          {error && <AuthBanner message={error} />}
          <button type="submit" className="btn primary" disabled={busy || !name.trim()} style={{ height: 40 }}>
            {busy ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create workspace", "إنشاء مساحة عمل")}
          </button>
        </form>
        <button type="button" className="btn ghost" onClick={logout}>
          {tx("Sign out", "تسجيل الخروج")}
        </button>
      </div>
    </AuthCard>
  );
}
