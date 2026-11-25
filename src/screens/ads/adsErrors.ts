import { ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";

/**
 * Localized copy for every SP-15 error key (`meta_ads.*`, `ads.*`), the OAuth
 * callback codes (`#/ads?metaAds=error&code=…`), the connection's
 * `statusReason` and its `lastSyncError`. Pure, and unit-tested for
 * completeness: every key has English and Arabic.
 *
 * The backend puts the key in `message` and extras next to it
 * (`{statusCode, message: "meta_ads.check_cooldown", retryAfter, nextAt}`),
 * which `ApiError` exposes as `.message` and `.body`.
 */

export interface Copy {
  en: string;
  ar: string;
}

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => Copy;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
};

/** Every HTTP error key the SP-15 routes return. */
export const ADS_ERROR_COPY: Record<string, CopyFn> = {
  "meta_ads.not_configured": () => ({
    en: "Meta Ads isn't set up on the server yet. Ask your administrator to finish the setup.",
    ar: "لم يُضبط ربط إعلانات Meta على الخادم بعد. اطلب من المسؤول إكمال الإعداد.",
  }),
  "meta_ads.encryption_unavailable": () => ({
    en: "The server can't store the Meta Ads login securely (TOKEN_ENC_KEY isn't set).",
    ar: "لا يستطيع الخادم حفظ تسجيل دخول إعلانات Meta بأمان (لم يُضبط TOKEN_ENC_KEY).",
  }),
  "meta_ads.no_ads_permission": () => ({
    en: "Meta didn't grant access to ads. Connect again and allow reading your ads.",
    ar: "لم تمنح Meta صلاحية الوصول إلى الإعلانات. اربط مجددًا واسمح بقراءة إعلاناتك.",
  }),
  "meta_ads.unknown_asset": () => ({
    en: "That ad account or Page isn't available to this login. Choose again.",
    ar: "هذا الحساب الإعلاني أو الصفحة غير متاح لتسجيل الدخول هذا. اختر مجددًا.",
  }),
  "meta_ads.login_expired": () => ({
    en: "The Meta login expired before you chose an account. Connect again.",
    ar: "انتهت صلاحية تسجيل الدخول إلى Meta قبل اختيار الحساب. اربط مجددًا.",
  }),
  "meta_ads.not_exchanged": () => ({
    en: "There's no Meta login waiting. Start with Connect.",
    ar: "لا يوجد تسجيل دخول إلى Meta بانتظار الاختيار. ابدأ بزر الربط.",
  }),
  "meta_ads.reconnect": () => ({
    en: "Meta refused this login. Connect again.",
    ar: "رفضت Meta تسجيل الدخول هذا. اربط مجددًا.",
  }),
  "meta_ads.connection_changed": () => ({
    en: "Someone else changed the Meta Ads connection meanwhile. Reload and try again.",
    ar: "غيّر شخص آخر ربط إعلانات Meta في هذه الأثناء. أعد التحميل وحاول مجددًا.",
  }),
  "meta_ads.not_connected": () => ({
    en: "Meta Ads isn't connected.",
    ar: "إعلانات Meta غير مربوطة.",
  }),
  "meta_ads.check_cooldown": (x) => {
    const s = num(x.retryAfter);
    return s
      ? { en: `Checked recently. Try again in ${s} s.`, ar: `تم الفحص مؤخرًا. حاول مجددًا بعد ${s} ث.` }
      : { en: "Checked recently. Try again shortly.", ar: "تم الفحص مؤخرًا. حاول مجددًا بعد قليل." };
  },
  "meta_ads.meta_refused": (x) => {
    const c = typeof x.graphCode === "number" || typeof x.graphCode === "string" ? String(x.graphCode) : null;
    return c
      ? { en: `Meta refused the request (Meta code ${c}). Try again later.`, ar: `رفضت Meta الطلب (رمز Meta ${c}). حاول لاحقًا.` }
      : { en: "Meta refused the request. Try again later.", ar: "رفضت Meta الطلب. حاول لاحقًا." };
  },
  "ads.not_found": () => ({
    en: "This ad no longer exists.",
    ar: "هذا الإعلان لم يعد موجودًا.",
  }),
  "ads.range_invalid": () => ({
    en: "Choose a date range of at most 366 days, with the start before the end.",
    ar: "اختر نطاق تواريخ لا يتجاوز 366 يومًا، يبدأ قبل نهايته.",
  }),
};

/** The OAuth callback's `code=` keys (plain, not `meta_ads.*`). */
export const OAUTH_RETURN_COPY: Record<string, Copy> = {
  invalid_state: {
    en: "The Meta login link expired or was already used. Connect again.",
    ar: "انتهت صلاحية رابط تسجيل الدخول إلى Meta أو استُخدم من قبل. اربط مجددًا.",
  },
  cancelled: {
    en: "The Meta login was cancelled.",
    ar: "أُلغي تسجيل الدخول إلى Meta.",
  },
  forbidden: {
    en: "You no longer have permission to connect Meta Ads.",
    ar: "لم تعد لديك صلاحية ربط إعلانات Meta.",
  },
  not_configured: {
    en: "Meta Ads isn't set up on the server yet.",
    ar: "لم يُضبط ربط إعلانات Meta على الخادم بعد.",
  },
  encryption_unavailable: {
    en: "The server can't store the Meta Ads login securely.",
    ar: "لا يستطيع الخادم حفظ تسجيل دخول إعلانات Meta بأمان.",
  },
  exchange_failed: {
    en: "Meta didn't complete the login. Try again.",
    ar: "لم تُكمل Meta تسجيل الدخول. حاول مجددًا.",
  },
  unknown: {
    en: "The Meta login didn't finish. Try again.",
    ar: "لم يكتمل تسجيل الدخول إلى Meta. حاول مجددًا.",
  },
};

/** `MetaAdsConnection.statusReason` (also the reconnect notification's `reason`). */
export const STATUS_REASON_COPY: Record<string, Copy> = {
  token_refused: { en: "Meta refused the login", ar: "رفضت Meta تسجيل الدخول" },
  account_refused: { en: "Meta refused access to the ad account", ar: "رفضت Meta الوصول إلى الحساب الإعلاني" },
};

/** `MetaAdsConnection.lastSyncError`. */
export const SYNC_ERROR_COPY: Record<string, Copy> = {
  rate_limited: { en: "Meta asked us to slow down; the next sync will continue.", ar: "طلبت Meta الإبطاء؛ ستستكمل المزامنة التالية." },
  sync_failed: { en: "The last sync failed; it will be retried.", ar: "فشلت المزامنة الأخيرة؛ ستُعاد المحاولة." },
  partial: { en: "The last sync finished only part of the days.", ar: "أكملت المزامنة الأخيرة جزءًا من الأيام فقط." },
  token_refused: STATUS_REASON_COPY.token_refused,
  account_refused: STATUS_REASON_COPY.account_refused,
};

/** The server settings `config.missing` can name (managers only). */
export const CONFIG_MISSING_COPY: Record<string, Copy> = {
  META_ADS_APP_ID: { en: "Meta app id", ar: "معرّف تطبيق Meta" },
  META_ADS_APP_SECRET: { en: "Meta app secret", ar: "المفتاح السري لتطبيق Meta" },
  META_ADS_LOGIN_CONFIG_ID: { en: "Login for Business configuration id", ar: "معرّف إعداد تسجيل الدخول للأعمال" },
  TOKEN_ENC_KEY: { en: "Token encryption key", ar: "مفتاح تشفير الرموز" },
};

export function adsErrorCopy(key: string, extra: Extra = {}): Copy | null {
  const fn = ADS_ERROR_COPY[key];
  return fn ? fn(extra) : null;
}

const pick = (table: Record<string, Copy>, key: string | null | undefined, tx: Tx): string | null => {
  if (!key) return null;
  const c = table[key];
  return c ? tx(c.en, c.ar) : null;
};

export const oauthReturnText = (code: string, tx: Tx): string =>
  pick(OAUTH_RETURN_COPY, code, tx) ?? tx(OAUTH_RETURN_COPY.unknown.en, OAUTH_RETURN_COPY.unknown.ar);
export const statusReasonText = (key: string | null | undefined, tx: Tx) => pick(STATUS_REASON_COPY, key, tx);
export const syncErrorText = (key: string | null | undefined, tx: Tx) =>
  key ? (pick(SYNC_ERROR_COPY, key, tx) ?? tx("The last sync failed.", "فشلت المزامنة الأخيرة.")) : null;

/** The extras of an ApiError body (`{statusCode, message, ...extra}`). */
export function errorExtras(e: unknown): Extra {
  if (e instanceof ApiError && e.body && typeof e.body === "object" && !Array.isArray(e.body)) return e.body as Extra;
  return {};
}

/** Localized text for anything an SP-15 call can throw; a 403 is the shared no-permission copy. */
export function adsErrorText(e: unknown, tx: Tx): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const copy = message ? adsErrorCopy(message, errorExtras(e)) : null;
  if (copy) return tx(copy.en, copy.ar);
  if ((e instanceof ApiError && e.status === 403) || message === "Forbidden" || message === "Missing permission") {
    return tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  }
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}
