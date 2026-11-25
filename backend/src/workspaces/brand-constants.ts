/**
 * SP-29 organization branding constants (Global Constraints). The frontend
 * mirror `src/screens/settings/brand.ts` (Task 2) is pinned to these values.
 */

/** Logo types (ruling 2): no SVG (script), no GIF (animation in the shell). */
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** `Media.purpose` of a workspace logo (hidden from the library and the agent's photos). */
export const LOGO_PURPOSE = "brand_logo";

export const BRAND_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** The chat page's colour when neither the channel nor the workspace sets one. */
export const DEFAULT_CHAT_COLOR = "#111827";
export const SAVED_FLASH_MS = 2000;

/** The public logo URL is immutable: a new logo gets a new media id, so a new URL. */
export const LOGO_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The relative public URL of a workspace's current logo. */
export const logoPath = (workspaceId: string, mediaId: string) =>
  `/api/branding/${encodeURIComponent(workspaceId)}/logo/${encodeURIComponent(mediaId)}`;
