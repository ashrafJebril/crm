import { HttpException } from "@nestjs/common";
import { MEMBER_ERROR_KEYS, memberError, memberErrorStatus } from "./member-errors";
import * as C from "./members-constants";
import { appPublicUrl, hashToken, isTokenShape, newToken } from "./token-hash";

describe("members constants, errors and tokens (SP-26)", () => {
  it("constants match the plan", () => {
    expect(C.INVITE_TTL_MS).toBe(7 * 24 * 3600 * 1000);
    expect(C.INVITE_RESEND_MAX).toBe(5);
    expect(C.INVITE_RESEND_GAP_MS).toBe(60_000);
    expect(C.RESET_TTL_MS).toBe(30 * 60_000);
    expect(C.RESET_LIVE_MAX).toBe(3);
    expect(C.PASSWORD_MIN).toBe(8);
    expect(C.TOTP_STEP_S).toBe(30);
    expect(C.TOTP_WINDOW).toBe(1);
    expect(C.RECOVERY_CODES).toBe(10);
    expect(C.TWO_FA_CHALLENGE_TTL_S).toBe(300);
    expect(C.AUDIT_PAGE).toBe(50);
  });

  it("every error key carries its status and key", () => {
    for (const key of MEMBER_ERROR_KEYS) {
      const e = memberError(key, { extra: 1 });
      expect(e).toBeInstanceOf(HttpException);
      expect(e.getStatus()).toBe(memberErrorStatus(key));
      expect(e.getResponse()).toEqual({ statusCode: memberErrorStatus(key), message: key, extra: 1 });
    }
    expect(memberErrorStatus("invitations.invalid")).toBe(410);
    expect(memberErrorStatus("invitations.resend_limited")).toBe(429);
    expect(memberErrorStatus("members.handover_required")).toBe(409);
  });

  it("tokens are 43-char base64url, distinct, and stored only as sha256 hex", () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(isTokenShape(a)).toBe(true);
    expect(isTokenShape("short")).toBe(false);
    expect(isTokenShape(`${a}=`)).toBe(false);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });

  it("app public url drops a trailing slash", () => {
    expect(appPublicUrl({ APP_PUBLIC_URL: "https://app.test/" })).toBe("https://app.test");
    expect(appPublicUrl({})).toBe("http://localhost:5174");
  });
});
