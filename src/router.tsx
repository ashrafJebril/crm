import { lazy, Suspense, useEffect, useState } from "react";
import type { RouteId } from "@/lib/types";

// Each screen is its own chunk — initial load only ships shell + Dashboard.
const screens: Record<RouteId, React.LazyExoticComponent<React.ComponentType>> = {
  dashboard: lazy(() => import("@/screens/Dashboard")),
  inbox: lazy(() => import("@/screens/Inbox")),
  calendar: lazy(() => import("@/screens/Calendar")),
  social: lazy(() => import("@/screens/Social")),
  campaigns: lazy(() => import("@/screens/Campaigns")),
  pipeline: lazy(() => import("@/screens/pipeline/PipelinePage")),
  workflows: lazy(() => import("@/screens/workflows/WorkflowsPage")),
  contacts: lazy(() => import("@/screens/Contacts")),
  followups: lazy(() => import("@/screens/FollowUps")),
  analytics: lazy(() => import("@/screens/Analytics")),
  templates: lazy(() => import("@/screens/Templates")),
  media: lazy(() => import("@/screens/Media")),
  team: lazy(() => import("@/screens/Team")),
  agent: lazy(() => import("@/screens/KewyAgent")),
  settings: lazy(() => import("@/screens/Settings")),
  channels: lazy(() => import("@/screens/channels/ChannelsPage")),
  ads: lazy(() => import("@/screens/ads/AdsPage")),
  admin: lazy(() => import("@/screens/Admin")),
  // SP-20: guided onboarding (signup and the "Continue setup" cards link here).
  setup: lazy(() => import("@/screens/setup/SetupPage")),
};

export const VALID_ROUTES = new Set<RouteId>(Object.keys(screens) as RouteId[]);

const parseHash = (): RouteId => {
  // The hash can carry a query string — hosted OAuth flows send the customer
  // back to `#/settings?zernio=connected&platform=…`. Match on the route part
  // alone, otherwise the whole string misses VALID and we'd strand them on the
  // dashboard instead of the Settings page they started from.
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  // The old Automations screen was folded into Workflows; keep its links working.
  const id = raw === "automations" ? "workflows" : raw;
  return VALID_ROUTES.has(id as RouteId) ? (id as RouteId) : "dashboard";
};

export function useRoute(): [RouteId, (r: RouteId) => void] {
  const [route, setRouteState] = useState<RouteId>(parseHash);

  useEffect(() => {
    // Rewrite the retired #/automations URL so the address bar matches the screen.
    const normalize = () => {
      if (/^#\/?automations(\?|$)/.test(window.location.hash)) {
        window.history.replaceState(null, "", window.location.hash.replace(/^#\/?automations/, "#/workflows"));
      }
    };
    normalize();
    const onHash = () => {
      normalize();
      setRouteState(parseHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setRoute = (r: RouteId) => {
    const h = window.location.hash;
    // Re-selecting the current route keeps its query (e.g. the inbox filter).
    if (h !== `#/${r}` && !h.startsWith(`#/${r}?`)) window.location.hash = `#/${r}`;
    setRouteState(r);
  };

  return [route, setRoute];
}

export function ScreenSlot({ route }: { route: RouteId }) {
  const Screen = screens[route];
  return (
    <Suspense fallback={<ScreenLoader />}>
      <Screen />
    </Suspense>
  );
}

function ScreenLoader() {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        color: "var(--ink-3)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
    >
      <div className="pulse">loading…</div>
    </div>
  );
}
