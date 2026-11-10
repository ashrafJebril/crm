/**
 * SP-15: click-to-WhatsApp referral parsing (pure).
 *
 * Meta-direct puts the referral on `entry[].changes[].value.messages[].referral`.
 * Zernio forwards it verbatim as `metadata.referral`, next to its own
 * attribution `metadata.ad` (ruling 2: `metadata` is read at the payload root
 * or under `message`; the location is unverified, ruling 13).
 *
 * Rules (Review Focus 1, "never fake attribution"):
 *  - a field Meta did not send stays null;
 *  - a value of the wrong type, over its cap, or (URLs) not `https:` is
 *    dropped to null, never truncated;
 *  - Zernio's names are used only when `metadata.ad.synced === true`, because
 *    an unsynced `name` is Meta's headline, not an ad name (ruling 3).
 */

export const HEADLINE_MAX = 512;
export const BODY_MAX = 4_000;
export const WELCOME_MAX = 4_000;
export const URL_MAX = 2_048;
export const CTWA_CLID_MAX = 512;
export const NAME_MAX = 512;
/** Meta ad / post ids: digits, sometimes `<page>_<post>`; never free text. */
const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** `ad` | `post`; any other lowercase token is kept verbatim. */
const TOKEN = /^[a-z_]{1,32}$/;

export interface ReferralNames {
  adName: string | null;
  adSetName: string | null;
  campaignName: string | null;
  /** `act_<digits>`, or null. */
  adAccountId: string | null;
}

export interface NormalizedReferral {
  sourceId: string;
  sourceType: string;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  /** The creative to show: `image_url` for an image ad, `thumbnail_url` for a video ad. */
  mediaUrl: string | null;
  videoUrl: string | null;
  sourceUrl: string | null;
  welcomeText: string | null;
  ctwaClid: string | null;
  /** Zernio synced attribution only; null otherwise (Meta never sends names). */
  names: ReferralNames | null;
}

/** Why a present referral was not captured (logged as a key, never the payload). */
export type ReferralDropKey = "referral_missing_source_id" | "referral_missing_source_type";
export type OnDrop = (key: ReferralDropKey) => void;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-empty string within `max`, as sent; anything else is null. */
export function capText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  if (v.trim() === "" || v.length > max) return null;
  return v;
}

/** An absolute `https:` URL within URL_MAX, as sent; anything else is null. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > URL_MAX) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

function sourceIdOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === "string" && SOURCE_ID.test(v) ? v : null;
}

function tokenOf(v: unknown): string | null {
  return typeof v === "string" && TOKEN.test(v) ? v : null;
}

/** `act_123` or `123` → `act_123`; anything else null. */
export function adAccountIdOf(v: unknown): string | null {
  const s = typeof v === "number" && Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string") return null;
  if (/^act_\d{1,32}$/.test(s)) return s;
  if (/^\d{1,32}$/.test(s)) return `act_${s}`;
  return null;
}

/** The creative link a referral shows: image → `image_url`, video → `thumbnail_url`. */
export function creativeLink(ref: Obj): string | null {
  const type = tokenOf(ref.media_type);
  if (type === "video") return httpsUrl(ref.thumbnail_url);
  if (type === "image") return httpsUrl(ref.image_url);
  // Unknown or missing media_type: whichever still image Meta sent.
  return httpsUrl(ref.image_url) ?? httpsUrl(ref.thumbnail_url);
}

/** Meta's `referral` object (also Zernio's verbatim `metadata.referral`). */
function parseReferralObject(
  raw: Obj,
  fallback: { sourceId?: string | null; sourceType?: string | null },
  onDrop?: OnDrop,
): Omit<NormalizedReferral, "names"> | null {
  const sourceId = sourceIdOf(raw.source_id) ?? fallback.sourceId ?? null;
  if (!sourceId) {
    onDrop?.("referral_missing_source_id");
    return null;
  }
  const sourceType = tokenOf(raw.source_type) ?? fallback.sourceType ?? null;
  if (!sourceType) {
    onDrop?.("referral_missing_source_type");
    return null;
  }
  const welcome = isObj(raw.welcome_message) ? raw.welcome_message.text : undefined;
  return {
    sourceId,
    sourceType,
    headline: capText(raw.headline, HEADLINE_MAX),
    body: capText(raw.body, BODY_MAX),
    mediaType: tokenOf(raw.media_type),
    mediaUrl: creativeLink(raw),
    videoUrl: httpsUrl(raw.video_url),
    sourceUrl: httpsUrl(raw.source_url),
    welcomeText: capText(welcome, WELCOME_MAX),
    ctwaClid: capText(raw.ctwa_clid, CTWA_CLID_MAX),
  };
}

/** Meta-direct: `messages[].referral`. Null when absent or unusable. */
export function parseMetaReferral(raw: unknown, onDrop?: OnDrop): NormalizedReferral | null {
  if (!isObj(raw)) return null;
  const ref = parseReferralObject(raw, {}, onDrop);
  return ref ? { ...ref, names: null } : null;
}

/** The Zernio `metadata` that carries attribution: root first, then `message.metadata`. */
export function zernioAttributionMetadata(evt: unknown): Obj | null {
  if (!isObj(evt)) return null;
  const message = isObj(evt.message) ? evt.message : null;
  for (const m of [evt.metadata, message?.metadata]) {
    if (isObj(m) && (isObj(m.referral) || isObj(m.ad))) return m;
  }
  return null;
}

/**
 * Zernio `message.received` / `conversation.started`. `names` only when
 * `metadata.ad.synced === true`. `metadata.ad.adId` is the fallback ad id
 * when the verbatim referral has no `source_id`.
 */
export function parseZernioReferral(evt: unknown, onDrop?: OnDrop): NormalizedReferral | null {
  const meta = zernioAttributionMetadata(evt);
  if (!meta) return null;
  const ad = isObj(meta.ad) ? meta.ad : null;
  const adId = ad ? sourceIdOf(ad.adId) : null;
  const raw = isObj(meta.referral) ? meta.referral : {};
  // Zernio's attribution object only exists for an ad, so an ad id taken from
  // it is an "ad"; a referral's own source_type always wins.
  const ref = parseReferralObject(raw, { sourceId: adId, sourceType: adId ? "ad" : null }, onDrop);
  if (!ref) return null;
  let names: ReferralNames | null = null;
  // Names describe Zernio's ad; never attach them to a different referral ad.
  if (ad && ad.synced === true && (!adId || adId === ref.sourceId)) {
    const n: ReferralNames = {
      adName: capText(ad.name, NAME_MAX),
      adSetName: capText(ad.adSetName, NAME_MAX),
      campaignName: capText(ad.campaignName, NAME_MAX),
      adAccountId: adAccountIdOf(ad.adAccountId),
    };
    if (n.adName || n.adSetName || n.campaignName || n.adAccountId) names = n;
  }
  return { ...ref, names };
}
