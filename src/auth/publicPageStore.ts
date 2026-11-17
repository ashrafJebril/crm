import { useEffect, useState } from "react";
import { parsePublicFragment, parsePublicLocation, scrubbedUrl, type PublicPage } from "./publicRoutes";

/**
 * SP-26: the token-bearing public page (accept invite, reset password) is read
 * from the URL once at boot, before React mounts, and the token is scrubbed
 * from the address bar with replaceState: it then lives only in this module's
 * memory, never in history, logs or storage.
 */
let captured: PublicPage | null = null;

/** Boot: read and scrub. Returns the page, if any. */
export function captureFromLocation(win: Pick<Window, "location" | "history">): PublicPage | null {
  const page = parsePublicLocation(win.location);
  if (!page) {
    // A token-shaped link that failed to parse still must not linger.
    if (/[?&]token=/.test(win.location.search) || /[?&]token=/.test(win.location.hash)) {
      const kind = /invite/.test(win.location.pathname + win.location.hash) ? "#/accept-invite" : "#/reset-password";
      win.history.replaceState(null, "", `/${kind}`);
    }
    return null;
  }
  captured = page;
  const lang = new URLSearchParams(win.location.search).get("lang");
  win.history.replaceState(null, "", scrubbedUrl(page, lang));
  return page;
}

function current(hash: string): PublicPage | null {
  const route = /^#\/?([a-z-]+)/.exec(hash)?.[1];
  if (route === "accept-invite") return captured?.kind === "accept" ? captured : { kind: "accept", token: "" };
  if (route === "reset-password") return captured?.kind === "reset" ? captured : { kind: "reset", token: "" };
  return parsePublicFragment(hash);
}

/**
 * A token link opened in an already-running tab (pasted, or followed from
 * another page of the app): the hash changes without a reload, so the boot
 * capture never saw it. Capture and scrub it now, exactly like at boot
 * (review M3). Returns the page when a token link was handled.
 */
export function captureTokenLink(win: Pick<Window, "location" | "history">): PublicPage | null {
  if (!/[?&]token=/.test(win.location.hash) && !/[?&]token=/.test(win.location.search)) return null;
  return captureFromLocation(win);
}

/** The page the app shows for a hash, after any token link in it was captured. */
export function pageForHash(win: Pick<Window, "location" | "history">): PublicPage | null {
  captureTokenLink(win);
  return current(win.location.hash);
}

/** The public page for the current hash (re-evaluated on hashchange). */
export function usePublicPage(): PublicPage | null {
  const [page, setPage] = useState<PublicPage | null>(() => current(window.location.hash));
  useEffect(() => {
    const on = () => setPage(pageForHash(window));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return page;
}

/** Leave the public page for an app route (the token is forgotten). */
export function leavePublicPage(route = "dashboard"): void {
  captured = null;
  window.history.replaceState(null, "", `/#/${route}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
