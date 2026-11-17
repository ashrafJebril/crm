/** SP-26 limits (plan Global Constraints → Constants). */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const INVITE_TTL_MS = 7 * DAY;
export const INVITE_RESEND_MAX = 5;
export const INVITE_RESEND_GAP_MS = 60_000;

export const RESET_TTL_MS = 30 * MIN;
export const RESET_LIVE_MAX = 3;
export const PASSWORD_MIN = 8;

export const TOTP_STEP_S = 30;
export const TOTP_WINDOW = 1;
export const RECOVERY_CODES = 10;
export const TWO_FA_CHALLENGE_TTL_S = 300;

export const AUDIT_PAGE = 50;

/** Invitation preview/accept: 30 per 15 min per IP. */
export const INVITE_PUBLIC_LIMIT = { limit: 30, windowMs: 15 * MIN };
