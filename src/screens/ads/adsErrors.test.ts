import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import {
  ADS_ERROR_COPY,
  CONFIG_MISSING_COPY,
  OAUTH_RETURN_COPY,
  STATUS_REASON_COPY,
  SYNC_ERROR_COPY,
  adsErrorText,
  oauthReturnText,
  syncErrorText,
} from "./adsErrors";

const ARABIC = /[؀-ۿ]/;
const en = makeTx("en");
const ar = makeTx("ar");

// Every key in backend meta-ads-errors.ts and ad-errors.ts (SP-15 Tasks 1–2).
const ERROR_KEYS = [
  "meta_ads.not_configured",
  "meta_ads.encryption_unavailable",
  "meta_ads.no_ads_permission",
  "meta_ads.unknown_asset",
  "meta_ads.login_expired",
  "meta_ads.not_exchanged",
  "meta_ads.reconnect",
  "meta_ads.connection_changed",
  "meta_ads.not_connected",
  "meta_ads.check_cooldown",
  "meta_ads.meta_refused",
  "ads.not_found",
  "ads.range_invalid",
];
const CALLBACK_CODES = ["invalid_state", "cancelled", "forbidden", "not_configured", "encryption_unavailable", "exchange_failed"];
const REASONS = ["token_refused", "account_refused"];
const SYNC_ERRORS = ["rate_limited", "sync_failed", "partial", "token_refused", "account_refused"];
const MISSING = ["META_ADS_APP_ID", "META_ADS_APP_SECRET", "META_ADS_LOGIN_CONFIG_ID", "TOKEN_ENC_KEY"];

const bilingual = (c: { en: string; ar: string }) => {
  expect(c.en.trim()).not.toBe("");
  expect(c.ar).toMatch(ARABIC);
  expect(c.en).not.toMatch(ARABIC);
};

describe("ads error copy covers every SP-15 key in both languages", () => {
  it("has copy for every HTTP error key, with and without extras", () => {
    expect(Object.keys(ADS_ERROR_COPY).sort()).toEqual([...ERROR_KEYS].sort());
    for (const k of ERROR_KEYS) {
      bilingual(ADS_ERROR_COPY[k]({}));
      bilingual(ADS_ERROR_COPY[k]({ retryAfter: 30, graphCode: 190, ids: ["act_1"], missing: ["X"], token: "pending", param: "cursor" }));
    }
  });

  it("covers every callback code, status reason, sync error and missing setting", () => {
    for (const k of CALLBACK_CODES) bilingual(OAUTH_RETURN_COPY[k]);
    for (const k of REASONS) bilingual(STATUS_REASON_COPY[k]);
    for (const k of SYNC_ERRORS) bilingual(SYNC_ERROR_COPY[k]);
    for (const k of MISSING) bilingual(CONFIG_MISSING_COPY[k]);
  });

  it("maps ApiErrors to localized text, with the cooldown seconds and the shared 403 copy", () => {
    const cooldown = new ApiError("meta_ads.check_cooldown", 429, undefined, { message: "meta_ads.check_cooldown", retryAfter: 42 });
    expect(adsErrorText(cooldown, en)).toBe("Checked recently. Try again in 42 s.");
    expect(adsErrorText(cooldown, ar)).toBe("تم الفحص مؤخرًا. حاول مجددًا بعد 42 ث.");
    expect(adsErrorText(new ApiError("Forbidden", 403), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
    expect(adsErrorText(new Error("meta_ads.unknown_key"), en)).toBe("Something went wrong. Try again.");
    expect(adsErrorText("ads.range_invalid", en)).toMatch(/366/);
  });

  it("never leaks a raw code for an unknown callback or sync error", () => {
    expect(oauthReturnText("zzz", en)).toBe("The Meta login didn't finish. Try again.");
    expect(syncErrorText("weird", ar)).toMatch(ARABIC);
    expect(syncErrorText(null, en)).toBeNull();
  });
});
