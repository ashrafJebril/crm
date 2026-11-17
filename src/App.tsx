import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTweaks } from "@/tweaks/context";
import { useRoute } from "@/router";
import { Sidebar } from "@/shell/Sidebar";
import { Topbar } from "@/shell/Topbar";
import { ScreenSlot } from "@/router";
import { CommandPalette } from "@/components/CommandPalette";
import { ToastProvider, useToast } from "@/components/Toast";
import { ZernioRedirectCapture } from "@/components/ZernioRedirectCapture";
import { useAuth } from "@/auth/context";
import { Login } from "@/auth/Login";
import { Signup, useSignupHash } from "@/auth/Signup";
import { PaymentLocked } from "@/auth/PaymentLocked";
import { ImpersonationBanner } from "@/shell/ImpersonationBanner";
import { RecordSheetHost } from "@/shell/RecordSheetHost";
import { CopilotHost } from "@/copilot/CopilotHost";
import { authScreen, isEmbedded, parseInbound, postToParent } from "@/embed/embed";
import { setEmbedVisible } from "@/embed/visibility";
import { invalidateIntegrations, refreshAfterConnect } from "@/embed/connected";
import { EmbedSignInFailed } from "@/embed/EmbedSignInFailed";
import type { RouteId } from "@/lib/types";
import { VALID_ROUTES } from "@/router";
import { makeTx } from "@/lib/tx";
import { usePublicPage } from "@/auth/publicPageStore";
import { langParam, type PublicPage } from "@/auth/publicRoutes";
import { AcceptInvite } from "@/auth/AcceptInvite";
import { ForgotPassword } from "@/auth/ForgotPassword";
import { ResetPassword } from "@/auth/ResetPassword";
import { Activate } from "@/auth/Activate";
import { NoWorkspace } from "@/auth/NoWorkspace";

export default function App() {
  const { t, setTweak } = useTweaks();
  const [route, setRoute] = useRoute();
  const { status, paymentOverdue } = useAuth();
  // SP-26: invite/reset/forgot/activate pages render before the auth gate.
  const publicPage = usePublicPage();
  // An emailed link's `?lang=` wins once over the stored language.
  useEffect(() => {
    const l = langParam(window.location.search);
    if (l) setTweak("lang", l);
  }, [setTweak]);

  if (status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "var(--bg)",
          color: "var(--ink-3)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
        }}
        className="pulse"
      >
        loading…
      </div>
    );
  }

  if (publicPage) return <PublicPageView page={publicPage} lang={t.lang} />;

  if (paymentOverdue) return <PaymentLocked />;

  // SP-26 ruling 6: signed in, no workspace (removed or invited).
  if (status === "noWorkspace") return <NoWorkspace />;

  const embedded = isEmbedded();
  const screen = authScreen(status, embedded);

  if (screen === "embed-failed") return <EmbedAnonymous />;
  // SP-20: the public signup page (#/signup) sits next to the sign-in page.
  if (screen === "login") return <AuthEntry />;

  if (embedded) {
    return (
      <ToastProvider>
        <ZernioRedirectCapture />
        <div className="app" data-embed="1">
          <EmbedBridge route={route} setRoute={setRoute} />
          <main className="main">
            <ScreenSlot route={route} />
          </main>
          <RecordSheetHost />
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ZernioRedirectCapture />
      <div className="app" data-collapsed={t.collapsed}>
        <ImpersonationBanner />
        <Sidebar route={route} setRoute={setRoute} />
        <main className="main">
          <Topbar route={route} />
          <ScreenSlot route={route} />
        </main>
        <RecordSheetHost />
        <CommandPalette />
        <CopilotHost />
      </div>
    </ToastProvider>
  );
}

function EmbedBridge({ route, setRoute }: { route: RouteId; setRoute: (r: RouteId) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    postToParent({ type: "kewy:ready" });
  }, []);

  useEffect(() => {
    postToParent({ type: "kewy:route", route });
  }, [route]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = parseInbound(e);
      if (!msg) return;
      if (msg.type === "kewy:navigate") {
        if (VALID_ROUTES.has(msg.route as RouteId)) setRoute(msg.route as RouteId);
      } else if (msg.type === "kewy:visibility") {
        setEmbedVisible(msg.visible);
      } else {
        toast("Account connected");
        void refreshAfterConnect(msg.provider, { invalidate: () => invalidateIntegrations(qc) });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [qc, toast, setRoute]);

  return null;
}

function EmbedAnonymous() {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    postToParent({ type: "kewy:sso-failed" });
  }, []);
  return <EmbedSignInFailed />;
}

/** SP-20: #/signup shows the signup page, anything else the sign-in page. */
function AuthEntry() {
  return useSignupHash() ? <Signup /> : <Login />;
}

/** SP-26: the public account pages, each in the page's language. */
function PublicPageView({ page, lang }: { page: PublicPage; lang: "ar" | "en" }) {
  const tx = makeTx(lang);
  switch (page.kind) {
    case "accept":
      return <AcceptInvite token={page.token} tx={tx} lang={lang} />;
    case "reset":
      return <ResetPassword token={page.token || null} tx={tx} lang={lang} />;
    case "forgot":
      return <ForgotPassword tx={tx} lang={lang} />;
    case "activate":
      return <Activate slug={page.slug} next={page.next} tx={tx} lang={lang} />;
  }
}
