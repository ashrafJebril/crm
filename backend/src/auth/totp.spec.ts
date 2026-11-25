import { HttpException } from "@nestjs/common";
import { AUTH_ERROR_KEYS, authError, authErrorStatus } from "./auth-errors";
import { base32Decode, base32Encode, hotp, otpauthUrl, stepAt, totpAt, verifyTotp } from "./totp";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  isRecoveryCodeShape,
  matchRecoveryCode,
  normaliseRecoveryCode,
} from "./recovery-codes";
import { SessionVersionService } from "./session-version.service";

/** RFC 6238 Appendix B, SHA-1 seed "12345678901234567890". */
const SEED = Buffer.from("12345678901234567890", "ascii");
const VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP (SP-26, RFC 6238)", () => {
  it("totp matches RFC 6238 vectors", () => {
    for (const [t, eight] of VECTORS) {
      const step = stepAt(t * 1000);
      expect({ t, code: hotp(SEED, step, 8) }).toEqual({ t, code: eight });
      // The 6-digit code is the tail of the 8-digit value.
      expect({ t, code: totpAt(SEED, step) }).toEqual({ t, code: eight.slice(-6) });
      expect(verifyTotp(SEED, eight.slice(-6), t * 1000, null)).toBe(step);
    }
  });

  it("base32 round-trips", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI"); // RFC 4648 §10, unpadded
    expect(base32Decode("mzxw6ytboi======").toString()).toBe("foobar");
    for (let n = 0; n < 40; n++) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255));
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(base32Decode(base32Encode(SEED)).equals(SEED)).toBe(true);
    expect(() => base32Decode("abc1")).toThrow("Invalid base32");
  });

  it("accepts one step either side, refuses further and refuses replays", () => {
    const secret = base32Encode(SEED);
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    expect(verifyTotp(secret, totpAt(secret, s - 1), now, null)).toBe(s - 1);
    expect(verifyTotp(secret, totpAt(secret, s + 1), now, null)).toBe(s + 1);
    expect(verifyTotp(secret, totpAt(secret, s - 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, s + 2), now, null)).toBeNull();
    // Replay guard: a step at or before lastStep is refused.
    expect(verifyTotp(secret, totpAt(secret, s), now, s)).toBeNull();
    expect(verifyTotp(secret, totpAt(secret, s), now, s - 1)).toBe(s);
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456"]) expect(verifyTotp(secret, bad, now, null)).toBeNull();
  });

  it("otpauth URL names the issuer and account", () => {
    const url = otpauthUrl("ABCDEF", "a+b@x.test");
    expect(url).toMatch(/^otpauth:\/\/totp\/tkana:a%2Bb%40x\.test\?/);
    const q = new URL(url.replace("otpauth://", "https://")).searchParams;
    expect(Object.fromEntries(q)).toEqual({ secret: "ABCDEF", issuer: "tkana", algorithm: "SHA1", digits: "6", period: "30" });
  });
});

describe("recovery codes (SP-26)", () => {
  it("ten distinct xxxx-xxxx codes, stored only as bcrypt, matched once per hash", async () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    const hashes = await hashRecoveryCodes(codes.slice(0, 3), 4);
    for (const h of hashes) expect(h).toMatch(/^\$2[aby]\$/);
    expect(hashes.join()).not.toContain(normaliseRecoveryCode(codes[0]));
    expect(await matchRecoveryCode(codes[1].toUpperCase().replace("-", " "), hashes)).toBe(hashes[1]);
    expect(await matchRecoveryCode(codes[5], hashes)).toBeNull();
    expect(isRecoveryCodeShape("abcd-efg1")).toBe(false);
    expect(await matchRecoveryCode("nope", hashes)).toBeNull();
  });
});

describe("auth errors (SP-26)", () => {
  it("every key carries its status and key", () => {
    for (const key of AUTH_ERROR_KEYS) {
      const e = authError(key);
      expect(e).toBeInstanceOf(HttpException);
      expect(e.getStatus()).toBe(authErrorStatus(key));
      expect(e.getResponse()).toMatchObject({ statusCode: authErrorStatus(key), message: key });
    }
    expect(authErrorStatus("auth.reset_invalid")).toBe(410);
    expect(authErrorStatus("auth.session_expired")).toBe(401);
    expect(authErrorStatus("auth.encryption_unavailable")).toBe(503);
  });
});

describe("SessionVersionService (SP-26 ruling 4)", () => {
  it("caches for 30 s, treats a missing sv as 0, and invalidates on bump", async () => {
    let version = 0;
    const findUnique = jest.fn(async () => ({ sessionVersion: version }));
    const svc = new SessionVersionService({ user: { findUnique } } as never);
    let now = 1_000_000;
    svc.now = () => now;
    expect(await svc.isCurrent("u1", undefined)).toBe(true);
    expect(await svc.isCurrent("u1", 0)).toBe(true);
    version = 1;
    expect(await svc.isCurrent("u1", 0)).toBe(true); // cached
    expect(findUnique).toHaveBeenCalledTimes(1);
    svc.invalidate("u1");
    expect(await svc.isCurrent("u1", 0)).toBe(false);
    expect(await svc.isCurrent("u1", 1)).toBe(true);
    version = 2;
    now += 30_001;
    expect(await svc.isCurrent("u1", 1)).toBe(false);
    expect(SessionVersionService.bump()).toEqual({ sessionVersion: { increment: 1 } });
  });

  it("a deleted user is never current", async () => {
    const svc = new SessionVersionService({ user: { findUnique: jest.fn().mockResolvedValue(null) } } as never);
    expect(await svc.isCurrent("gone", 0)).toBe(false);
  });
});
