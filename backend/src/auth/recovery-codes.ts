import { randomBytes } from "crypto";
import * as bcrypt from "bcryptjs";
import { RECOVERY_CODES } from "../members/members-constants";
import { base32Encode } from "./totp";

/** `xxxx-xxxx`, lower-case base32 (40 random bits each). Shown once. */
export function generateRecoveryCodes(n = RECOVERY_CODES): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(5)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
}

/** The form that is hashed and compared: upper-case, no spaces or dashes. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function isRecoveryCodeShape(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z2-7]{8}$/.test(normaliseRecoveryCode(code));
}

/** Stored only as bcrypt hashes. */
export function hashRecoveryCodes(codes: string[], rounds = 10): Promise<string[]> {
  return Promise.all(codes.map((c) => bcrypt.hash(normaliseRecoveryCode(c), rounds)));
}

/** The stored hash `code` matches, or null. Checks every hash. */
export async function matchRecoveryCode(code: string, hashes: string[]): Promise<string | null> {
  if (!isRecoveryCodeShape(code)) return null;
  const norm = normaliseRecoveryCode(code);
  let hit: string | null = null;
  for (const h of hashes) {
    if ((await bcrypt.compare(norm, h)) && hit === null) hit = h;
  }
  return hit;
}
