import { Component, lazy, type ComponentType, type ReactNode } from "react";

/**
 * Lazy-loading that survives a deploy.
 *
 * Every screen is its own hashed chunk, and the web image bakes `dist` straight
 * into nginx (see the root Dockerfile). A deploy therefore REPLACES the whole
 * asset set — the previous build's files stop existing.
 *
 * So a tab that loaded `index.html` before a deploy is holding a map of chunk
 * names that are now 404s. The moment the user opens a screen they hadn't
 * visited yet, the dynamic import fails:
 *
 *   GET /assets/Campaigns-CXayhAXm.js   404
 *   TypeError: Failed to fetch dynamically imported module
 *
 * React's `lazy` turns that rejection into a render error, and with no error
 * boundary above it the whole tree unmounts — a blank white page.
 *
 * Retrying the same URL can never help: that file is genuinely gone. The only
 * cure is a full reload, which fetches a fresh `index.html` with the new
 * hashes. So that is what this does, once.
 */

/** Session key holding when we last auto-reloaded for a missing chunk. */
const RELOAD_KEY = "kewy:chunk-reload-at";
/** Two reloads inside this window means reloading is not fixing it. */
const RELOAD_COOLDOWN_MS = 15_000;

function isMissingChunk(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Wording differs across browsers, so match the shapes rather than one string.
  return (
    /dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) || // Safari
    /error loading dynamically imported module/i.test(msg) || // Firefox
    /ChunkLoadError/i.test(msg)
  );
}

/** Reload once. Returns false when we already tried that very recently. */
function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Private mode / blocked storage: a single reload is still better than a
    // white screen, and the cooldown below is only a loop guard.
  }
  window.location.reload();
  return true;
}

/**
 * Drop-in replacement for `lazy()` that reloads the page when the chunk is
 * missing because a deploy moved it.
 */
export function lazyScreen<T extends ComponentType<Record<string, never>>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (isMissingChunk(err) && reloadOnce()) {
        // The page is on its way out — never resolve, so React keeps showing
        // the Suspense fallback instead of flashing an error first.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }),
  );
}

/**
 * Last line of defence. Without this, ANY error thrown while rendering a
 * screen (not just a missing chunk) unmounts the entire app and leaves a blank
 * page — the app had no error boundary at all before this.
 */
export class ScreenErrorBoundary extends Component<
  { children: ReactNode; fallback: (retry: () => void) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // A chunk can also go missing on a retry *after* Suspense resolved, so the
    // same recovery applies here.
    if (isMissingChunk(error)) reloadOnce();
    // Keep it in the console for support; there is no error reporter wired up.
    console.error("Screen failed to render:", error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) return this.props.fallback(this.reset);
    return this.props.children;
  }
}
