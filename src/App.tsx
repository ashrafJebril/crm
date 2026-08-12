import { useTweaks } from "@/tweaks/context";
import { useRoute } from "@/router";
import { Sidebar } from "@/shell/Sidebar";
import { Topbar } from "@/shell/Topbar";
import { ScreenSlot } from "@/router";
import { CommandPalette } from "@/components/CommandPalette";
import { ToastProvider } from "@/components/Toast";
import { ZernioRedirectCapture } from "@/components/ZernioRedirectCapture";
import { useAuth } from "@/auth/context";
import { Login } from "@/auth/Login";
import { ImpersonationBanner } from "@/shell/ImpersonationBanner";

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

  if (status === "anonymous") {
    return <Login />;
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
