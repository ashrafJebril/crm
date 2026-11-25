import { Suspense, useEffect, useState } from "react";
import { lazyScreen, ScreenErrorBoundary } from "@/lib/lazyScreen";
import { confirmLeave } from "@/lib/leaveGuard";
import { routeHash } from "@/lib/langParam";
import type { RouteId } from "@/lib/types";

// Each screen is its own chunk — initial load only ships shell + Dashboard.
const screens: Record<RouteId, React.LazyExoticComponent<React.ComponentType>> = {
  dashboard: lazyScreen(() => import("@/screens/Dashboard")),
  inbox: lazyScreen(() => import("@/screens/Inbox")),
  calendar: lazyScreen(() => import("@/screens/Calendar")),
  social: lazyScreen(() => import("@/screens/Social")),
  campaigns: lazyScreen(() => import("@/screens/Campaigns")),
  pipeline: lazyScreen(() => import("@/screens/pipeline/PipelinePage")),
  workflows: lazyScreen(() => import("@/screens/workflows/WorkflowsPage")),
  contacts: lazyScreen(() => import("@/screens/Contacts")),
  followups: lazyScreen(() => import("@/screens/FollowUps")),
  analytics: lazyScreen(() => import("@/screens/Analytics")),
  templates: lazyScreen(() => import("@/screens/Templates")),
  media: lazyScreen(() => import("@/screens/Media")),
  team: lazyScreen(() => import("@/screens/Team")),
  agent: lazyScreen(() => import("@/screens/KewyAgent")),
  settings: lazyScreen(() => import("@/screens/Settings")),
  channels: lazyScreen(() => import("@/screens/channels/ChannelsPage")),
  ads: lazyScreen(() => import("@/screens/ads/AdsPage")),
  admin: lazyScreen(() => import("@/screens/Admin")),
  // SP-20: guided onboarding (signup and the "Continue setup" cards link here).
  setup: lazyScreen(() => import("@/screens/setup/SetupPage")),
  // SP-18: the member's own copilot chats (reached from the drawer).
  copilot: lazyScreen(() => import("@/screens/copilot/CopilotHistory")),
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
    const changes = h !== `#/${r}` && !h.startsWith(`#/${r}?`);
    // SP-29: ask the leave guard before the current screen unmounts.
    if (changes && !confirmLeave()) return;
    // SP-30: the new route drops the old query but keeps `?lang=`.
    if (changes) window.location.hash = routeHash(r, h);
    setRouteState(r);
  };

  return [route, setRoute];
}

export function ScreenSlot({ route }: { route: RouteId }) {
  const Screen = screens[route];
  return (
    // Keyed by route so a failed screen does not keep the boundary tripped
    // after the user navigates somewhere else.
    <ScreenErrorBoundary key={route} fallback={(retry) => <ScreenError onRetry={retry} />}>
      <Suspense fallback={<ScreenLoader />}>
        <Screen />
      </Suspense>
    </ScreenErrorBoundary>
  );
}

/**
 * Shown when a screen fails to render. Before this existed the app had no
 * error boundary at all, so the same failure produced a blank white page with
 * no way back except the browser's reload button.
 */
function ScreenError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: 24,
        textAlign: "center",
      }}
    >
      <div style={{ display: "grid", gap: 12, maxWidth: 360 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>This screen didn’t load</div>
        <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
          It’s usually a new version being released while this tab was open.
          Reloading picks it up.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    </div>
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
