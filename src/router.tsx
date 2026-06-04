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
  contacts: lazy(() => import("@/screens/Contacts")),
  analytics: lazy(() => import("@/screens/Analytics")),
  templates: lazy(() => import("@/screens/Templates")),
  media: lazy(() => import("@/screens/Media")),
  team: lazy(() => import("@/screens/Team")),
  settings: lazy(() => import("@/screens/Settings")),
  admin: lazy(() => import("@/screens/Admin")),
};

const VALID = new Set<RouteId>(Object.keys(screens) as RouteId[]);

const parseHash = (): RouteId => {
  const id = window.location.hash.replace(/^#\/?/, "");
  return VALID.has(id as RouteId) ? (id as RouteId) : "dashboard";
};

export function useRoute(): [RouteId, (r: RouteId) => void] {
  const [route, setRouteState] = useState<RouteId>(parseHash);

  useEffect(() => {
    const onHash = () => setRouteState(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setRoute = (r: RouteId) => {
    if (window.location.hash !== `#/${r}`) window.location.hash = `#/${r}`;
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
