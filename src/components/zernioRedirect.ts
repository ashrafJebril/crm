import { splitHash } from "@/lib/hashState";

/**
 * m4: Zernio's OAuth now returns to `#/channels?zernio=connected&…`, which
 * needs channels.view. A member who can connect but not view channels (a
 * custom role) is sent to Settings with the same params instead, where the
 * old redirect used to land. Null when no rewrite is needed.
 */
export function zernioRedirectTarget(hash: string, canViewChannels: boolean): string | null {
  if (canViewChannels) return null;
  const { path, params } = splitHash(hash);
  if (path.replace(/^#\/?/, "") !== "channels") return null;
  if (params.get("zernio") !== "connected") return null;
  return `#/settings?${params.toString()}`;
}
