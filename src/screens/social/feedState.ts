/**
 * What a platform's feed should show. "Not connected" is only a fact once the
 * Zernio status has loaded — before that the account is unknown, and treating
 * unknown as disconnected flashes the empty state on every cold page load.
 */
export type FeedState = "checking" | "status-error" | "disconnected" | "loading" | "posts-error" | "ready";

export function feedState(input: {
  /** The status request has returned data at least once. */
  statusLoaded: boolean;
  statusError: string | null;
  connected: boolean;
  /** The posts request has returned data at least once. */
  postsLoaded: boolean;
  postsError: string | null;
}): FeedState {
  if (!input.statusLoaded) return input.statusError ? "status-error" : "checking";
  if (!input.connected) return "disconnected";
  if (!input.postsLoaded) return input.postsError ? "posts-error" : "loading";
  return "ready";
}

/** Still waiting on something before the feed can be trusted. */
export const isFeedPending = (s: FeedState) => s === "checking" || s === "loading";
