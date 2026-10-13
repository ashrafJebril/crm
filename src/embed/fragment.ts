import { connectCallbackProvider, shouldConsumeTiremallSso } from "./embed";
import { VALID_ROUTES } from "../router";
import { skinFromLocation, type HostSkin } from "./skin";

export interface FragmentDeps {
  markEmbedded(): void;
  notifyOpenerConnected(provider: string): boolean;
  setToken(token: string): void;
  clearToken(): void;
  applySkin(s: HostSkin): void;
  storedSkin(): HostSkin | null;
  mergeTheme(theme: "dark" | "light"): void;
  replaceState(url: string): void;
}

export interface FragmentResult {
  pendingTiremallSso: string | null;
  closingAsPopup: boolean;
}

type Loc = { search: string; hash: string; pathname: string };

/**
 * Boot-time URL handling: embed flag, host skin, popup close, #tmsso and the
 * hjz #token/theme flow. Pure of globals so it can be tested.
 */
export function consumeEmbedFragment(
  loc: Loc,
  win: Window,
  deps: FragmentDeps,
): FragmentResult {
  const result: FragmentResult = { pendingTiremallSso: null, closingAsPopup: false };
  const scrub = () => deps.replaceState(`${loc.pathname}${loc.search}`);
  const isEmbedLoad = new URLSearchParams(loc.search).get("embed") === "1";
  if (isEmbedLoad) deps.markEmbedded();
  // The skin is honoured only for a real embed: ?embed=1 AND actually framed.
  const framed = shouldConsumeTiremallSso(loc.search, win);
  const hashParams = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const skinInHash = hashParams.has("skin");
  if (framed) {
    const effective = skinFromLocation(loc, true) ?? (skinInHash ? null : deps.storedSkin());
    if (effective) deps.applySkin(effective);
  }

  const cb = connectCallbackProvider(loc);
  if (cb && deps.notifyOpenerConnected(cb)) {
    result.closingAsPopup = true;
    return result;
  }
  // Embed-only deep link: land directly on the requested screen so the
  // Dashboard never loads first. Only honoured when framed AND a known route.
  const routeParam = hashParams.get("route");
  const route = framed && routeParam && (VALID_ROUTES as ReadonlySet<string>).has(routeParam) ? routeParam : null;
  const scrubEmbed = () =>
    deps.replaceState(`${loc.pathname}${loc.search}${route ? `#/${route}` : ""}`);
  if (!loc.hash || loc.hash.length < 2) return result;
  const tmsso = hashParams.get("tmsso");
  if (tmsso && framed) {
    result.pendingTiremallSso = tmsso;
    deps.clearToken();
    scrubEmbed();
    return result;
  }
  const token = hashParams.get("token");
  const theme = hashParams.get("theme");
  if (!token || token === "undefined" || token === "null") {
    if (framed && (skinInHash || route)) scrubEmbed();
    return result;
  }
  deps.setToken(token);
  if (theme === "dark" || theme === "light") deps.mergeTheme(theme);
  scrub();
  return result;
}
