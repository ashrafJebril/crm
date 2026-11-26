import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

const ALL_CHANNELS = ["facebook", "instagram", "tiktok"] as const;
export type PublishChannel = (typeof ALL_CHANNELS)[number];

/**
 * Instagram publishing options.
 *
 * These reach Instagram through Zernio's `platforms[].platformSpecificData`,
 * NOT through Meta's Graph API — so the names here are Zernio's, which differ
 * from the Graph ones the product spec was written against (`location_id` ->
 * `locationId`, `trial_params` -> `trialParams`, and so on).
 *
 * Two options in that spec are deliberately absent: POLLS and the COMMENT
 * PROMPT. Zernio's Instagram field list is closed — they document no
 * passthrough for unknown keys — so neither is reachable until Zernio adds
 * them. Do not add fields here speculatively; an unknown key is at best
 * ignored and at worst rejects the whole post.
 */
export class InstagramUserTagDto {
  @IsString() @MaxLength(30) username!: string;
  /** 0.0-1.0 from the left. Required for images; ignored on video and Reels. */
  @IsOptional() @IsNumber() @Min(0) @Max(1) x?: number;
  /** 0.0-1.0 from the top. */
  @IsOptional() @IsNumber() @Min(0) @Max(1) y?: number;
  /** Which carousel slide, 0-based. */
  @IsOptional() @IsInt() @Min(0) mediaIndex?: number;
}

export class InstagramAudioDto {
  /** From GET /v1/accounts/{id}/instagram/audio — not a Meta audio id. */
  @IsString() audioId!: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) audioVolume?: number;
  /** 0 mutes the video's own sound. */
  @IsOptional() @IsInt() @Min(0) @Max(100) videoVolume?: number;
}

export class InstagramTrialDto {
  /**
   * SS_PERFORMANCE: Instagram promotes it to followers by itself if the first
   * 72 hours go well. MANUAL: it stays a trial until the account owner acts —
   * and note that promoting a MANUAL trial later has no documented endpoint,
   * at Zernio or at Meta, so it is done in the Instagram app.
   */
  @IsIn(["MANUAL", "SS_PERFORMANCE"]) graduationStrategy!: "MANUAL" | "SS_PERFORMANCE";
}

export class InstagramOptionsDto {
  /** "story" publishes to Stories; omit for a feed post, carousel or Reel
   *  (Zernio infers a Reel from a single video). */
  @IsOptional() @IsIn(["story"]) contentType?: "story";

  /** A NUMERIC Facebook Page id, not a place name — Zernio has no location
   *  search endpoint, so the UI cannot offer a picker. */
  @IsOptional() @IsString() locationId?: string;

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InstagramUserTagDto)
  userTags?: InstagramUserTagDto[];

  /** Public Business or Creator accounts. Invites stay pending until accepted;
   *  Zernio drops names it cannot resolve. */
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsString({ each: true })
  collaborators?: string[];

  /** Labels AI-generated MEDIA, not an AI-written caption. */
  @IsOptional() @IsBoolean() isAiGenerated?: boolean;

  /** Reels only, and requires the account to be connected with Facebook
   *  Login — Instagram Login answers 400 instagram_audio_requires_facebook_login. */
  @IsOptional() @ValidateNested() @Type(() => InstagramAudioDto)
  audioConfiguration?: InstagramAudioDto;

  /** Replaces "Original audio" on a Reel. Settable only at creation. */
  @IsOptional() @IsString() @MaxLength(100) audioName?: string;

  /** Reels only. false keeps it in the Reels tab, off the main feed. */
  @IsOptional() @IsBoolean() shareToFeed?: boolean;

  @IsOptional() @ValidateNested() @Type(() => InstagramTrialDto)
  trialParams?: InstagramTrialDto;

  /** Reel cover as milliseconds into the video. Loses to instagramThumbnail. */
  @IsOptional() @IsInt() @Min(0) thumbOffset?: number;

  /** Reel cover image, publicly reachable. JPEG or PNG, 1080x1920 preferred. */
  @IsOptional() @IsUrl({ protocols: ["https"], require_protocol: true })
  instagramThumbnail?: string;

  /** Applied just after publishing and best-effort: if Instagram refuses the
   *  toggle the post still goes up WITH comments on. */
  @IsOptional() @IsBoolean() commentsEnabled?: boolean;

  /** Where links belong — Instagram captions do not linkify. Feed and
   *  carousels only. */
  @IsOptional() @IsString() @MaxLength(2200) firstComment?: string;

  /** Strips the video's audio. Permanent, and unavailable over 200 MB. */
  @IsOptional() @IsBoolean() muteAudio?: boolean;
}

/**
 * Facebook Page options, verified against Zernio's OpenAPI `FacebookPlatformData`
 * schema. Location, tagging people and CTA buttons are absent because they are
 * not in that schema and unknown keys are not forwarded.
 *
 * Alt text, SRT captions and video covers are NOT here on purpose — they live
 * on the media item (`altTexts`, `subtitles`, `thumbnail`), shared across
 * platforms.
 */
export class FacebookGeoDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(25) @IsString({ each: true })
  countries!: string[];
}

export class FacebookOptionsDto {
  @IsOptional() @IsIn(["story", "reel"]) contentType?: "story" | "reel";
  /** Reel only. */
  @IsOptional() @IsString() @MaxLength(255) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) firstComment?: string;
  /** Only labels Reels and video Stories; accepted-and-ignored elsewhere. */
  @IsOptional() @IsBoolean() isAiGenerated?: boolean;
  @IsOptional() @IsString() pageId?: string;
  @IsOptional() @ValidateNested() @Type(() => FacebookGeoDto) geoRestriction?: FacebookGeoDto;
  /** Numeric Page IDs, Reels only, max 10. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) collaborators?: string[];
  /** Facebook's own draft state in Publishing Tools. */
  @IsOptional() @IsBoolean() draft?: boolean;
}

export class PublishDto {
  @IsString()
  @MinLength(1)
  @MaxLength(63206)
  content!: string;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  mediaIds?: string[];

  /** Per-media alt text, positionally matched to `mediaIds`. Instagram keeps
   *  it for images only; Zernio ignores it on Reels, Stories and video slides. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(1000, { each: true })
  altTexts?: string[];

  /** Subtitle tracks per media item, positionally matched to `mediaIds`.
   *  SRT or WebVTT URLs; Facebook takes every track up to 200 KB each. */
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  subtitleUrls?: string[][];

  /** Instagram-only options. Ignored for the other channels. */
  @IsOptional() @ValidateNested() @Type(() => InstagramOptionsDto)
  instagram?: InstagramOptionsDto;

  /** Facebook-only options. Ignored for the other channels. */
  @IsOptional() @ValidateNested() @Type(() => FacebookOptionsDto)
  facebook?: FacebookOptionsDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ALL_CHANNELS.length)
  @IsIn(ALL_CHANNELS, { each: true })
  channels!: PublishChannel[];

  /** ISO 8601 instant. Present = schedule instead of publish immediately. */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;

  /** IANA timezone the user scheduled in (e.g. "Asia/Riyadh"). */
  @IsOptional()
  @IsString()
  timezone?: string;
}

export class RescheduleDto {
  @IsISO8601()
  scheduledFor!: string;

  @IsString()
  timezone!: string;
}
