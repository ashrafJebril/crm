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
import { ImpersonationBanner } from "@/shell/ImpersonationBanner";
import { authScreen, isEmbedded, parseInbound, postToParent } from "@/embed/embed";
import { EmbedSignInFailed } from "@/embed/EmbedSignInFailed";
import type { RouteId } from "@/lib/types";
import { VALID_ROUTES } from "@/router";

export default function App() {
  const { t } = useTweaks();
  const [route, setRoute] = useRoute();
  const { status } = useAuth();

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

  const embedded = isEmbedded();
  const screen = authScreen(status, embedded);

  if (screen === "embed-failed") return <EmbedAnonymous />;
  if (screen === "login") return <Login />;

  if (embedded) {
    return (
      <ToastProvider>
        <ZernioRedirectCapture />
        <div className="app" data-embed="1">
          <EmbedBridge route={route} setRoute={setRoute} />
          <main className="main">
            <ScreenSlot route={route} />
          </main>
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
        <CommandPalette />
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
      } else {
        void qc.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0] as string).startsWith("/integrations"),
        });
        toast("Account connected");
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
