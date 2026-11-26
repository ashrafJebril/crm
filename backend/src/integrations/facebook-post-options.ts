import { BadRequestException } from "@nestjs/common";

/**
 * Facebook Page publishing options, as Zernio takes them.
 *
 * Verified against Zernio's OpenAPI schema `FacebookPlatformData`
 * (zernio.com/openapi.json, 2026-11-26) rather than the prose docs — the
 * schema is the contract and it disagreed with the docs more than once.
 * `FacebookPlatformData` has exactly nine properties; these are the eight that
 * are inputs (`failedCollaborators` is output-only).
 *
 * NOT here, because they are not in the schema and `additionalProperties` is
 * absent, so unknown keys are not forwarded:
 *  - location / `place`
 *  - tagging people (`tags`)
 *  - call-to-action buttons (WhatsApp / Messages / Call / Website)
 *
 * Three things the product spec expected here live on the MEDIA ITEM instead,
 * shared across platforms, not under platformSpecificData:
 *  - alt text              → mediaItems[].altText
 *  - SRT/WebVTT captions   → mediaItems[].subtitles
 *  - video or Reel cover   → mediaItems[].thumbnail
 */
export interface FacebookOptions {
  /** Omit for a feed post. */
  contentType?: "story" | "reel";
  /** Reel only, separate from the caption. */
  title?: string;
  /** Feed posts and Reels, not Stories. Skipped on drafts. */
  firstComment?: string;
  /**
   * Meta's AI-disclosure label. Per the schema it is only forwarded as
   * `is_ai_generated` on REELS and VIDEO STORIES — "Meta documents no such
   * parameter for feed posts, feed videos or photo Stories, so the flag is
   * accepted with a warning and no label there". So offering it elsewhere
   * promises a badge that will not appear.
   */
  isAiGenerated?: boolean;
  /** Which Page, when the account manages several. */
  pageId?: string;
  /** Country allowlist. Not supported on Stories. */
  geoRestriction?: { countries: string[] };
  /** Numeric Page IDs, Reels only. People cannot be collaborators. */
  collaborators?: string[];
  /** Facebook's own draft state, in Publishing Tools. */
  draft?: boolean;
}

const REEL_ONLY = [
  ["title", "a Reel title"],
  ["collaborators", "collaborators"],
] as const;

/**
 * Reject what Facebook will refuse, before the post is created — same reasoning
 * as the Instagram guard: a rejection otherwise lands as a generic per-platform
 * error long after the composer closed, and hours later for a scheduled post.
 */
export function assertFacebookOptions(fb: FacebookOptions, mediaCount: number): void {
  const bad = (msg: string) => {
    throw new BadRequestException(msg);
  };

  if (fb.contentType !== "reel") {
    for (const [key, label] of REEL_ONLY) {
      if (fb[key] !== undefined) bad(`Facebook allows ${label} on Reels only.`);
    }
  }

  if (fb.contentType === "story") {
    if (fb.firstComment !== undefined) bad("Facebook Stories cannot take a first comment.");
    // Schema: "Stories (Facebook, Instagram) do not support geo-restriction."
    if (fb.geoRestriction !== undefined) bad("Facebook Stories cannot be geo-restricted.");
    if (mediaCount > 1) bad("A Facebook Story takes a single photo or video.");
  }

  if (fb.collaborators) {
    if (fb.collaborators.length > 10) bad("Facebook allows at most 10 Reel collaborators.");
    // Schema is explicit that these are numeric PAGE ids; a username is
    // silently ignored with a warning, so catch it while it can be fixed.
    const bogus = fb.collaborators.filter((c) => !/^\d+$/.test(c));
    if (bogus.length) {
      bad(`Facebook collaborators must be numeric Page IDs — "${bogus[0]}" is not.`);
    }
  }

  const countries = fb.geoRestriction?.countries;
  if (countries) {
    if (!countries.length) bad("Choose at least one country, or remove the restriction.");
    if (countries.length > 25) bad("At most 25 countries can be listed.");
    const malformed = countries.filter((c) => !/^[A-Z]{2}$/.test(c));
    if (malformed.length) bad(`"${malformed[0]}" is not a 2-letter country code.`);
  }
}

/**
 * The `platformSpecificData` payload for Facebook.
 *
 * `draft` is nested under `facebookSettings` to match the schema; the rest sit
 * at the top of the platform entry. Only keys actually set are included — a
 * present key is a decision to Zernio.
 */
export function facebookPlatformData(fb: FacebookOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  };

  put("contentType", fb.contentType);
  put("title", fb.title);
  put("firstComment", fb.firstComment);
  put("pageId", fb.pageId);
  put("collaborators", fb.collaborators?.length ? fb.collaborators : undefined);
  if (fb.isAiGenerated !== undefined) out.isAiGenerated = fb.isAiGenerated;
  if (fb.geoRestriction?.countries?.length) {
    out.geoRestriction = { countries: fb.geoRestriction.countries };
  }
  if (fb.draft !== undefined) out.facebookSettings = { draft: fb.draft };
  return out;
}
