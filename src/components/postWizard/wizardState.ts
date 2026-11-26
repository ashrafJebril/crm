import { capability, mediaLimits, type OptionKey, type Platform, type PostKind } from "./capabilities";

/**
 * The wizard's state and the rules for moving through it.
 *
 * Kept out of the component so the rules are testable: which step you may
 * reach, what blocks publishing, and — the important one — what gets STRIPPED
 * when you change platform or post type.
 *
 * That last point is the whole reason this file exists. Someone fills in a
 * Reel's music, switches to Story, and publishes. Without pruning, the options
 * travel with them: either the backend rejects the post, or worse Zernio
 * accepts and silently ignores them. Pruning on change means what you see is
 * what is sent.
 */

export type Step = "type" | "media" | "details" | "preview" | "share";
export const STEPS: Step[] = ["type", "media", "details", "preview", "share"];

export interface WizardState {
  platform: Platform;
  kind: PostKind;
  content: string;
  mediaIds: string[];
  altTexts: Record<string, string>;
  options: Partial<Record<OptionKey, unknown>>;
  scheduledFor: Date | null;
  asDraft: boolean;
}

export const emptyState = (platform: Platform = "instagram"): WizardState => ({
  platform,
  kind: "post",
  content: "",
  mediaIds: [],
  altTexts: {},
  options: {},
  scheduledFor: null,
  asDraft: false,
});

/**
 * Drop anything the new platform/kind cannot do, and trim media past the new
 * limit. Returns the state to use.
 */
export function retarget(
  state: WizardState,
  next: { platform?: Platform; kind?: PostKind },
): WizardState {
  const platform = next.platform ?? state.platform;
  const kind = next.kind ?? state.kind;
  const { max } = mediaLimits(platform, kind);

  const options: Partial<Record<OptionKey, unknown>> = {};
  for (const [key, value] of Object.entries(state.options)) {
    if (capability(platform, kind, key as OptionKey).supported) {
      options[key as OptionKey] = value;
    }
  }

  const mediaIds = state.mediaIds.slice(0, max);
  // Alt text belongs to a media item, so it goes when that item does.
  const altTexts: Record<string, string> = {};
  for (const id of mediaIds) if (state.altTexts[id]) altTexts[id] = state.altTexts[id];

  // A caption the new kind will not show is dead weight, but DELETING what
  // someone typed is worse than carrying it: switching Story -> post must not
  // lose their words. Keep it; the Details step simply stops showing it.
  return { ...state, platform, kind, options, mediaIds, altTexts };
}

/** Why this step cannot be completed yet, or null when it can. */
export function blockedReason(
  state: WizardState,
  step: Step,
  tx: (en: string, ar: string) => string,
): string | null {
  const { min, max } = mediaLimits(state.platform, state.kind);

  if (step === "media") {
    if (state.mediaIds.length < min) {
      return state.kind === "post"
        ? tx("Add at least one photo or video.", "أضف صورة أو فيديو واحداً على الأقل.")
        : tx("Add one video.", "أضف فيديو واحداً.");
    }
    if (state.mediaIds.length > max) {
      return tx(`At most ${max} items.`, `بحد أقصى ${max} عنصراً.`);
    }
  }

  if (step === "details" && capability(state.platform, state.kind, "caption").supported) {
    // Instagram needs media, so an empty caption is fine. Facebook feed text
    // posts are the only case where content alone carries the post.
    if (!state.mediaIds.length && !state.content.trim()) {
      return tx("Write something, or add media.", "اكتب نصاً أو أضف ملفاً.");
    }
  }

  return null;
}

/** May the user move to this step yet? */
export function canReach(state: WizardState, step: Step, tx: (en: string, ar: string) => string) {
  const index = STEPS.indexOf(step);
  for (const earlier of STEPS.slice(0, index)) {
    if (blockedReason(state, earlier, tx)) return false;
  }
  return true;
}

/** One setting that is actually in force on this post. */
export interface ActiveSetting {
  key: OptionKey | "altText";
  label: string;
  /** Reduces who sees the post or how they can respond — worth a second look
   *  before publishing, not just a quiet line in a list. */
  warn?: boolean;
}

/**
 * Everything the user has turned on, in the words they'd recognise.
 *
 * This exists because a Reel went out with comments off and nobody could tell
 * until they opened Instagram. The wizard asked for the setting five steps
 * earlier, below the fold, and then never mentioned it again — so the only
 * feedback was the published post. Settings that cost you reach or replies
 * are marked `warn` so they read as a decision rather than a detail.
 *
 * Only options the current platform and kind actually support are listed: a
 * stale value pruned by `retarget` must not be announced as if it were live.
 */
export function activeSettings(
  state: WizardState,
  tx: (en: string, ar: string) => string,
): ActiveSetting[] {
  const o = state.options;
  const out: ActiveSetting[] = [];
  const on = (key: OptionKey) => capability(state.platform, state.kind, key).supported;
  const add = (key: ActiveSetting["key"], label: string, warn?: boolean) =>
    out.push({ key, label, ...(warn ? { warn: true } : {}) });

  if (on("altText")) {
    const n = state.mediaIds.filter((id) => state.altTexts[id]?.trim()).length;
    if (n) add("altText", tx(`Alt text on ${n}`, `نص بديل على ${n}`));
  }
  if (on("location") && o.location) add("location", tx("Location", "موقع"));
  if (on("tagPeople")) {
    const t = o.tagPeople as unknown[] | undefined;
    if (t?.length) add("tagPeople", tx(`${t.length} tagged`, `${t.length} إشارة`));
  }
  if (on("collaborators")) {
    const c = o.collaborators as string[] | undefined;
    if (c?.length) add("collaborators", tx(`${c.length} collaborators`, `${c.length} متعاونين`));
  }
  if (on("reelTitle") && o.reelTitle) add("reelTitle", tx("Title set", "عنوان محدد"));
  if (on("aiLabel") && o.aiLabel === true) add("aiLabel", tx("AI label", "وسم ذكاء اصطناعي"));
  if (on("audioTrack") && o.audioTrack) add("audioTrack", tx("Music", "موسيقى"));
  if (on("audioName") && o.audioName) add("audioName", tx("Audio renamed", "اسم صوت مخصص"));
  if (on("cover") && o.cover) add("cover", tx("Custom cover", "غلاف مخصص"));
  if (on("subtitles")) {
    const s = o.subtitles as unknown[] | undefined;
    if (s?.length) add("subtitles", tx("Subtitles", "ترجمات"));
  }
  if (on("firstComment") && o.firstComment) add("firstComment", tx("First comment", "تعليق أول"));

  // The ones that cost something.
  if (on("shareToFeed") && o.shareToFeed === false)
    add("shareToFeed", tx("Not on profile feed", "لا يظهر في الملف الشخصي"), true);
  if (on("trialReel") && o.trialReel)
    add("trialReel", tx("Trial reel — non-followers only", "ريل تجريبي — لغير المتابعين"), true);
  if (on("geoRestriction") && o.geoRestriction)
    add("geoRestriction", tx("Geo-restricted", "مقيّد جغرافياً"), true);
  if (on("commentsOff") && o.commentsOff === true)
    add("commentsOff", tx("Comments off", "التعليقات مغلقة"), true);

  return out;
}

/** The request body for POST /social/publish. */
export interface PublishBody {
  content: string;
  mediaIds?: string[];
  altTexts?: string[];
  channels: Platform[];
  scheduledFor?: string;
  timezone?: string;
  /** Only one of these is ever set — whichever platform was chosen. Both are
   * declared so callers can read either without narrowing a union first. */
  instagram?: Record<string, unknown>;
  facebook?: Record<string, unknown>;
}

export function publishBody(state: WizardState): PublishBody {
  const o = state.options;
  const pick = <T,>(key: OptionKey): T | undefined =>
    capability(state.platform, state.kind, key).supported ? (o[key] as T) : undefined;

  const altTexts = state.mediaIds.map((id) => state.altTexts[id] ?? "");

  const common = {
    content: state.content,
    mediaIds: state.mediaIds.length ? state.mediaIds : undefined,
    altTexts: altTexts.some((t) => t.trim()) ? altTexts : undefined,
    channels: [state.platform],
    scheduledFor: state.scheduledFor ? state.scheduledFor.toISOString() : undefined,
    timezone: state.scheduledFor
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined,
  };

  if (state.platform === "instagram") {
    return {
      ...common,
      instagram: dropEmpty({
        contentType: state.kind === "story" ? "story" : undefined,
        locationId: pick<string>("location"),
        userTags: pick<unknown[]>("tagPeople"),
        collaborators: pick<string[]>("collaborators"),
        isAiGenerated: pick<boolean>("aiLabel"),
        audioConfiguration: pick<object>("audioTrack"),
        audioName: pick<string>("audioName"),
        shareToFeed: pick<boolean>("shareToFeed"),
        trialParams: pick<object>("trialReel"),
        instagramThumbnail: pick<string>("cover"),
        commentsEnabled: pick<boolean>("commentsOff") === true ? false : undefined,
        firstComment: pick<string>("firstComment"),
      }),
    };
  }

  return {
    ...common,
    facebook: dropEmpty({
      // Facebook names Reels explicitly; Instagram infers them from the media.
      contentType: state.kind === "post" ? undefined : state.kind,
      title: pick<string>("reelTitle"),
      firstComment: pick<string>("firstComment"),
      isAiGenerated: pick<boolean>("aiLabel"),
      collaborators: pick<string[]>("collaborators"),
      geoRestriction: pick<{ countries: string[] }>("geoRestriction"),
      draft: state.asDraft ? true : undefined,
    }),
  };
}

function dropEmpty<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out = Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  ) as T;
  return Object.keys(out).length ? out : undefined;
}
