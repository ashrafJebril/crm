/**
 * SP-12: namespaced failure codes on CampaignRecipient.failureCode. The
 * frontend mirror (src/screens/campaigns/failureCodes.ts, Task 3) holds the
 * bilingual copy; this file only produces the codes.
 *
 * - `skip:<reason>`: left out at launch by us.
 * - `meta:<n>`: Meta's WhatsApp error code, as Zernio or Meta reports it.
 * - `provider:unknown`: a provider failure with no integer code.
 */

export const SKIP_CODES = {
  opted_out: "skip:opted_out",
  no_phone: "skip:no_phone",
} as const;
export type SkipReason = keyof typeof SKIP_CODES;

export const PROVIDER_UNKNOWN = "provider:unknown";

/** Meta codes with bilingual copy in the UI. Any other `meta:<n>` shows "WhatsApp error <n>". */
export const KNOWN_META_FAILURE_CODES = [
  "meta:131026", // message undeliverable
  "meta:131047", // more than 24 h since the customer replied
  "meta:131049", // held for ecosystem engagement / per-user marketing limit
  "meta:131050", // the customer stopped marketing messages
  "meta:131056", // pair rate limit
  "meta:131048", // spam rate limit
  "meta:131042", // business payment issue
  "meta:131031", // account locked
  "meta:131051", // unsupported message type
  "meta:131052", // media download error
  "meta:131053", // media upload error
  "meta:132000", // template parameter count mismatch
  "meta:132001", // template does not exist
  "meta:132015", // template paused
  "meta:132016", // template disabled
  "meta:130472", // the customer's number is in a Meta experiment
  "meta:131000", // something went wrong
  "meta:368", // temporarily blocked for policy violations
] as const;

export const FAILURE_REASON_MAX = 300;
export const SHORT_TITLE_MAX = 120;

/** `meta:<n>` for a non-negative integer code (number or digit string), else null. */
export function metaFailureCode(errorCode: unknown): string | null {
  if (typeof errorCode === "number") {
    return Number.isInteger(errorCode) && errorCode >= 0 ? `meta:${errorCode}` : null;
  }
  if (typeof errorCode === "string" && /^\d{1,10}$/.test(errorCode.trim())) return `meta:${Number(errorCode.trim())}`;
  return null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Code and stored reason for a provider failure. The reason is the
 * explanation (else the error), flattened to one line and cut to 300
 * characters. It is never rendered raw: the UI shows it only when
 * `isShortTitle` holds.
 */
export function providerFailure(
  error: string | null | undefined,
  errorCode: unknown,
  explanation: string | null | undefined,
): { failureCode: string; failureReason: string | null } {
  const raw = [explanation, error].find((s) => typeof s === "string" && s.trim() !== "");
  return {
    failureCode: metaFailureCode(errorCode) ?? PROVIDER_UNKNOWN,
    failureReason: raw ? oneLine(raw).slice(0, FAILURE_REASON_MAX) : null,
  };
}

/** Tkana's rule: a provider text is shown only if it is one line, at most 120 characters and has no `{`. */
export function isShortTitle(s: string | null | undefined): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 0 && t.length <= SHORT_TITLE_MAX && !/[\r\n]/.test(t) && !t.includes("{");
}
