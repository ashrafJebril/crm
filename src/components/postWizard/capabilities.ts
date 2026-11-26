/**
 * What each platform and post type actually supports.
 *
 * Every entry is taken from Zernio's OpenAPI schema (zernio.com/openapi.json,
 * read 2026-11-26) — `FacebookPlatformData`, `InstagramPlatformData` and
 * `MediaItem` — not from the product specs and not from Zernio's prose docs,
 * both of which were wrong in places:
 *
 *  - the specs are written against Meta's Graph API, which we never call;
 *  - the docs omit Facebook `isAiGenerated` entirely, and bury alt text,
 *    subtitles and video covers on the media item rather than in the
 *    platform's own options.
 *
 * The point of this table is that the wizard can only offer a field where it
 * does something. A control that silently does nothing is worse than a missing
 * one: the user believes they set it.
 */

export type Platform = "instagram" | "facebook";
export type PostKind = "post" | "reel" | "story";

export interface Capability {
  /** Shown and sent. */
  supported: boolean;
  /** Why not, for the UI to explain rather than just hide the control. */
  reason?: string;
}

const YES: Capability = { supported: true };
const no = (reason: string): Capability => ({ supported: false, reason });

/** Every option the wizard's Details step can offer. */
export type OptionKey =
  | "caption"
  | "altText"
  | "subtitles"
  | "cover"
  | "location"
  | "tagPeople"
  | "collaborators"
  | "aiLabel"
  | "firstComment"
  | "commentsOff"
  | "audioTrack"
  | "audioName"
  | "shareToFeed"
  | "trialReel"
  | "geoRestriction"
  | "reelTitle"
  | "nativeDraft"
  | "poll"
  | "commentPrompt"
  | "ctaButton";

/** Options no platform can do through Zernio, with the reason. */
const NEVER: Partial<Record<OptionKey, string>> = {
  poll: "Zernio does not expose Instagram polls, and unknown fields are not forwarded.",
  commentPrompt: "Zernio does not expose the comment prompt.",
  ctaButton: "Call-to-action buttons are an Ads feature; organic posts cannot carry them.",
};

export function capability(
  platform: Platform,
  kind: PostKind,
  option: OptionKey,
): Capability {
  const never = NEVER[option];
  if (never) return no(never);

  if (platform === "instagram") return instagram(kind, option);
  return facebook(kind, option);
}

function instagram(kind: PostKind, option: OptionKey): Capability {
  switch (option) {
    case "caption":
      // Schema: Stories show no caption.
      return kind === "story" ? no("Instagram Stories do not show a caption.") : YES;
    case "altText":
      // MediaItem.altText: "Instagram (feed images only, not Reels/Stories)".
      return kind === "post" ? YES : no("Instagram applies alt text to feed images only.");
    case "location":
      return kind === "story"
        ? no("Instagram Stories cannot carry a location tag through the API.")
        : YES;
    case "tagPeople":
      return YES; // photos need x/y, Reels username-only — handled at the field
    case "collaborators":
      return kind === "story" ? no("Stories cannot have collaborators.") : YES;
    case "commentsOff":
      return kind === "story" ? no("Stories have no comments.") : YES;
    case "firstComment":
      return kind === "story" ? no("Stories cannot take a first comment.") : YES;
    case "aiLabel":
      return YES;
    case "audioTrack":
    case "audioName":
    case "shareToFeed":
    case "trialReel":
    case "cover":
      return kind === "reel" ? YES : no("Reels only.");
    case "subtitles":
      // MediaItem.subtitles lists YouTube, Facebook, LinkedIn, X, Bluesky.
      return no("Instagram does not accept subtitle files.");
    case "geoRestriction":
      return no("Geo-restriction is not supported on Instagram.");
    case "reelTitle":
    case "nativeDraft":
      return no("Facebook only.");
    default:
      return no("Not available.");
  }
}

function facebook(kind: PostKind, option: OptionKey): Capability {
  switch (option) {
    case "caption":
      return kind === "story" ? no("Facebook Stories do not show a caption.") : YES;
    case "altText":
      return kind === "post" ? YES : no("Alt text applies to photos in a feed post.");
    case "subtitles":
      // Facebook takes every track, up to 200 KB each.
      return kind === "story" ? no("Stories do not take subtitle files.") : YES;
    case "cover":
      // MediaItem.thumbnail: Facebook video posts AND Reels.
      return kind === "story" ? no("Stories do not take a custom cover.") : YES;
    case "aiLabel":
      // Schema is explicit: forwarded only on Reels and VIDEO stories; on feed
      // posts it is "accepted with a warning and no label". Offering it there
      // would promise a badge that never appears.
      return kind === "post"
        ? no("Facebook only shows the AI label on Reels and video Stories.")
        : YES;
    case "collaborators":
    case "reelTitle":
      return kind === "reel" ? YES : no("Facebook allows this on Reels only.");
    case "firstComment":
      return kind === "story" ? no("Stories cannot take a first comment.") : YES;
    case "geoRestriction":
      return kind === "story" ? no("Stories cannot be geo-restricted.") : YES;
    case "nativeDraft":
      return kind === "story" ? no("Stories cannot be saved as a draft.") : YES;
    case "location":
      return no("Zernio does not expose a location field for Facebook.");
    case "tagPeople":
      return no("Zernio does not expose people-tagging for Facebook.");
    case "commentsOff":
      return no("Turning comments off is not available for Facebook through Zernio.");
    case "audioTrack":
    case "audioName":
    case "shareToFeed":
    case "trialReel":
      return no("Instagram only.");
    default:
      return no("Not available.");
  }
}

/** How many media items this platform and kind accepts. */
export function mediaLimits(platform: Platform, kind: PostKind): { min: number; max: number } {
  if (kind === "story") return { min: 1, max: 1 };
  if (kind === "reel") return { min: 1, max: 1 };
  // Feed: Instagram carousels take up to 20 (not the 10 the spec assumed);
  // Facebook's docs disagree with themselves (10 vs 20), so take the lower.
  return { min: 1, max: platform === "instagram" ? 20 : 10 };
}

/** Options the wizard should render for this platform and kind, in order. */
export function visibleOptions(platform: Platform, kind: PostKind): OptionKey[] {
  const order: OptionKey[] = [
    "altText",
    "location",
    "tagPeople",
    "collaborators",
    "reelTitle",
    "aiLabel",
    "audioTrack",
    "audioName",
    "cover",
    "shareToFeed",
    "trialReel",
    "subtitles",
    "geoRestriction",
    "firstComment",
    "commentsOff",
  ];
  return order.filter((o) => capability(platform, kind, o).supported);
}
