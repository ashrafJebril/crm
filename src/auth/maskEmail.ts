/**
 * Mirror of backend/src/members/mask-email.ts: `nora@example.com` →
 * `n***@example.com` (first letter, masked local part, domain kept).
 * maskEmail.test.ts pins both to the same outputs.
 */
export function maskEmail(email: string): string {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${e[0]}***${e.slice(at)}`;
}
