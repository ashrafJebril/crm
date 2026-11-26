import { BadRequestException } from "@nestjs/common";

/**
 * Instagram publishing options, as Zernio takes them.
 *
 * These go out in `platforms[].platformSpecificData` on `POST /v1/posts`.
 * The names are ZERNIO'S, which differ from the Meta Graph names the product
 * spec was written against — `location_id` → `locationId`, `trial_params` →
 * `trialParams`, `comment_enabled` → `commentsEnabled`, and so on. We never
 * talk to Graph directly, so the Graph names are not an option.
 *
 * Polls and the comment prompt are absent on purpose. Zernio's Instagram field
 * list is closed and they document no passthrough for unknown keys, so neither
 * is reachable until Zernio adds them. Do not add speculative fields here: an
 * unknown key is at best dropped and at worst fails the whole post.
 */
export interface InstagramOptions {
  contentType?: "story";
  locationId?: string;
  userTags?: Array<{ username: string; x?: number; y?: number; mediaIndex?: number }>;
  collaborators?: string[];
  isAiGenerated?: boolean;
  audioConfiguration?: { audioId: string; audioVolume?: number; videoVolume?: number };
  audioName?: string;
  shareToFeed?: boolean;
  trialParams?: { graduationStrategy: "MANUAL" | "SS_PERFORMANCE" };
  thumbOffset?: number;
  instagramThumbnail?: string;
  commentsEnabled?: boolean;
  firstComment?: string;
  muteAudio?: boolean;
}

/** A Story is one media item, no caption, and most options do not apply. */
const STORY_FORBIDDEN = [
  ["locationId", "a location"],
  ["collaborators", "collaborators"],
  ["audioConfiguration", "library audio"],
  ["audioName", "an audio name"],
  ["shareToFeed", "share-to-feed"],
  ["trialParams", "trial reel settings"],
  ["firstComment", "a first comment"],
] as const;

/** Reel-only options, rejected elsewhere by Instagram. */
const REEL_ONLY = [
  ["audioConfiguration", "library audio"],
  ["audioName", "an audio name"],
  ["shareToFeed", "share-to-feed"],
  ["trialParams", "trial reels"],
  ["thumbOffset", "a cover frame"],
  ["instagramThumbnail", "a cover image"],
] as const;

/**
 * Reject combinations Instagram will refuse, before the post is created.
 *
 * Worth doing here rather than letting it fail downstream: a rejected publish
 * surfaces as a generic per-platform `errorMessage` well after the user has
 * left the composer, and for a SCHEDULED post that is hours later. Failing at
 * submit, naming the option, is the difference between a fixable mistake and a
 * silent no-show.
 *
 * `mediaCount` is how many items the post carries, which is what separates a
 * Reel (one video) from a carousel.
 */
export function assertInstagramOptions(ig: InstagramOptions, mediaCount: number): void {
  const bad = (msg: string) => {
    throw new BadRequestException(msg);
  };

  if (ig.contentType === "story") {
    for (const [key, label] of STORY_FORBIDDEN) {
      if (ig[key] !== undefined) bad(`Instagram Stories cannot take ${label}.`);
    }
    if (mediaCount > 1) bad("An Instagram Story takes a single photo or video.");
  }

  // A carousel is more than one item, so none of the Reel options can apply.
  if (mediaCount > 1) {
    for (const [key, label] of REEL_ONLY) {
      if (ig[key] !== undefined) bad(`An Instagram carousel cannot take ${label}.`);
    }
  }

  if (mediaCount > 20) bad("An Instagram carousel takes at most 20 items.");

  if (ig.collaborators && ig.collaborators.length > 3) {
    bad("Instagram allows at most 3 collaborators.");
  }

  if (ig.thumbOffset !== undefined && ig.instagramThumbnail) {
    // Zernio resolves this silently in the image's favour; say so rather than
    // let someone wonder why their chosen frame was ignored.
    bad("Choose either a cover image or a cover frame, not both.");
  }

  // Positions are required for photos and meaningless on video. We cannot see
  // the media type here, so only catch the clearly-wrong case: one coordinate
  // without the other.
  for (const tag of ig.userTags ?? []) {
    const hasX = tag.x !== undefined;
    const hasY = tag.y !== undefined;
    if (hasX !== hasY) bad(`Tag "${tag.username}" needs both x and y, or neither.`);
    if (tag.mediaIndex !== undefined && tag.mediaIndex >= Math.max(mediaCount, 1)) {
      bad(`Tag "${tag.username}" points at a slide that isn't in this post.`);
    }
  }
}

/**
 * The `platformSpecificData` payload for Instagram.
 *
 * Only keys the caller actually set are included: Zernio treats a present key
 * as a decision, so sending `commentsEnabled: undefined` is not the same as
 * omitting it.
 */
export function instagramPlatformData(ig: InstagramOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  };

  put("contentType", ig.contentType);
  put("locationId", ig.locationId);
  put("collaborators", ig.collaborators?.length ? ig.collaborators : undefined);
  put("isAiGenerated", ig.isAiGenerated);
  put("audioConfiguration", ig.audioConfiguration);
  put("audioName", ig.audioName);
  put("shareToFeed", ig.shareToFeed);
  put("trialParams", ig.trialParams);
  put("instagramThumbnail", ig.instagramThumbnail);
  put("commentsEnabled", ig.commentsEnabled);
  put("firstComment", ig.firstComment);
  put("muteAudio", ig.muteAudio);
  // 0 is a legitimate cover frame (the first frame), so it cannot go through
  // the falsy-dropping `put` above.
  if (ig.thumbOffset !== undefined) out.thumbOffset = ig.thumbOffset;

  if (ig.userTags?.length) {
    out.userTags = ig.userTags.map((t) => ({
      username: t.username.replace(/^@/, ""),
      ...(t.x !== undefined ? { x: t.x } : {}),
      ...(t.y !== undefined ? { y: t.y } : {}),
      ...(t.mediaIndex !== undefined ? { mediaIndex: t.mediaIndex } : {}),
    }));
  }
  return out;
}
