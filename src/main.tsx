import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { TweaksProvider } from "@/tweaks/context";
import { AuthProvider } from "@/auth/context";
import { API_BASE, tokenStore } from "@/api/client";
import { connectCallbackProvider, markEmbedded, notifyOpenerConnected, postToParent } from "@/embed/embed";
import { EmbedSignInFailed } from "@/embed/EmbedSignInFailed";
import "./styles/index.css";

// HJZ SSO landing — when /marketing/* opens this app via the launcher, the
// minted tkana token is passed in the URL fragment (#token=...). Lift it into
// `tokenStore` synchronously BEFORE React mounts so AuthProvider's bootstrap
// sees an authenticated session on its first run (no login-screen flash).
// The fragment is then stripped from the URL — never sent to a server, never
// stored in proxy/access logs, and never visible after the redirect resolves.
// Tiremall SSO (embed mode): a `tmsso` fragment carries a one-time Tiremall
// token. It is NOT a session — it is exchanged for one via the backend before
// React mounts (see bootstrap below).
let pendingTiremallSso: string | null = null;
let closingAsPopup = false;

(function consumeSsoFragment() {
  if (typeof window === "undefined") return;
  const qs = new URLSearchParams(window.location.search);
  if (qs.get("embed") === "1") markEmbedded();
  // Connect popup: if this load is a Zernio/Facebook callback and we have an
  // opener, tell it and close. The app must not mount (popup has no session).
  const cb = connectCallbackProvider(window.location);
  if (cb && notifyOpenerConnected(cb)) {
    closingAsPopup = true;
    return;
  }
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const tmsso = params.get("tmsso");
  if (tmsso) {
    pendingTiremallSso = tmsso;
    // Drop any stale session so a failed exchange can't fall back to it.
    tokenStore.clear();
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", `${pathname}${search}`);
    return;
  }
  const token = params.get("token");
  const theme = params.get("theme");
  // Reject the literal string "undefined" — happens if the upstream forgot to
  // include `accessToken` on the SSO exchange response. Treat as no token.
  if (!token || token === "undefined" || token === "null") return;
  tokenStore.set(token);
  // Inherit hjz's light/dark choice. TweaksProvider reads localStorage
  // synchronously in its initializer, so we merge into the stored object
  // BEFORE React mounts — otherwise the page paints in the saved theme
  // first and flips on the next tick. The accent picker stays at "green"
  // (it's overridden in tokens.css to gold anyway, but writing through
  // would interfere with any future user customization).
  if (theme === "dark" || theme === "light") {
    try {
      const STORAGE_KEY = "aram.tweaks.v1";
      const raw = localStorage.getItem(STORAGE_KEY);
      const prev = raw ? JSON.parse(raw) : {};
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, theme }));
    } catch {
      /* localStorage may be unavailable in privacy mode — fall through */
    }
  }
  // Replace state to scrub the fragment without adding a history entry.
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}`);
})();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

// Shared cache for every useFetch call in the app. Two components asking for
// the same URL share one in-flight request and one cached payload — no more
// duplicate GETs on render.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const root = createRoot(rootEl);

function mount() {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TweaksProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </TweaksProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

async function exchangeTiremallSso(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/auth/sso/tiremall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { accessToken?: string };
    if (!json.accessToken) return false;
    tokenStore.set(json.accessToken);
    return true;
  } catch {
    return false;
  }
}

if (closingAsPopup) {
  // window.close() issued; render nothing.
} else if (pendingTiremallSso) {
  void exchangeTiremallSso(pendingTiremallSso).then((ok) => {
    if (ok) {
      mount();
    } else {
      root.render(<EmbedSignInFailed />);
      postToParent({ type: "kewy:sso-failed" });
    }
  });
} else {
  mount();
}
