import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { TweaksProvider } from "@/tweaks/context";
import { AuthProvider } from "@/auth/context";
import { API_BASE, tokenStore } from "@/api/client";
import { markEmbedded, notifyOpenerConnected, postToParent } from "@/embed/embed";
import { EmbedSignInFailed } from "@/embed/EmbedSignInFailed";
import { applySkin, storedSkin } from "@/embed/skin";
import { setEmbedVisible } from "@/embed/visibility";
import { consumeEmbedFragment } from "@/embed/fragment";
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
const fragment = (function () {
  if (typeof window === "undefined") return { pendingTiremallSso: null, closingAsPopup: false };
  return consumeEmbedFragment(window.location, window, {
    markEmbedded,
    notifyOpenerConnected,
    setToken: (t) => tokenStore.set(t),
    clearToken: () => tokenStore.clear(),
    applySkin: (sk) => applySkin(sk),
    storedSkin,
    mergeTheme: (theme) => {
      // Inherit hjz's light/dark choice before TweaksProvider's synchronous
      // localStorage read, so the page doesn't paint in the saved theme first.
      try {
        const STORAGE_KEY = "aram.tweaks.v1";
        const raw = localStorage.getItem(STORAGE_KEY);
        const prev = raw ? JSON.parse(raw) : {};
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prev, theme }));
      } catch {
        /* localStorage may be unavailable in privacy mode */
      }
    },
    setVisible: setEmbedVisible,
    replaceState: (url) => window.history.replaceState(null, "", url),
  });
})();
const pendingTiremallSso = fragment.pendingTiremallSso;
const closingAsPopup = fragment.closingAsPopup;

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
