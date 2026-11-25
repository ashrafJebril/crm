import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { RouteId } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { memberErrorText } from "@/screens/team/memberErrors";
import { useAuth } from "./context";
import { AuthBanner, AuthCard, AuthTitle } from "./AuthCard";
import { leavePublicPage } from "./publicPageStore";
import { Login } from "./Login";

/**
 * SP-26 `#/activate?ws=<slug>&next=<route>` (ruling 10): switch to the
 * workspace with that slug and open `next` (already a known RouteId). An
 * unknown slug is 404; a workspace the user is not in answers
 * `{member:false}` and reveals nothing else.
 */
export function Activate({ slug, next, tx, lang }: { slug: string; next: RouteId; tx: Tx; lang: "ar" | "en" }) {
  const { status, switchWorkspace, activeWorkspace } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const signedIn = status === "authenticated" || status === "noWorkspace";

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ id?: string; name?: string; member: boolean }>(`/auth/workspaces/by-slug/${encodeURIComponent(slug)}`);
        if (cancelled) return;
        if (!r.member || !r.id) {
          setError(tx("You're not a member of this workspace. Ask an owner for an invitation.", "لست عضوًا في مساحة العمل هذه. اطلب دعوة من المالك."));
          return;
        }
        if (activeWorkspace?.id !== r.id) await switchWorkspace(r.id);
        if (!cancelled) leavePublicPage(next);
      } catch (e) {
        if (!cancelled) setError(memberErrorText(e, tx));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, slug, next]);

  if (!signedIn) return <Login />;
  return (
    <AuthCard dir={lang === "ar" ? "rtl" : "ltr"}>
      <AuthTitle title={tx("Opening workspace…", "جارٍ فتح مساحة العمل…")} />
      {error && (
        <div style={{ display: "grid", gap: 12 }}>
          <AuthBanner message={error} />
          <button type="button" className="btn ghost" onClick={() => leavePublicPage("dashboard")}>
            {tx("Continue", "متابعة")}
          </button>
        </div>
      )}
    </AuthCard>
  );
}
